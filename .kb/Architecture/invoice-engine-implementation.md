# Invoice & Billing Engine — implementation log

The centralized invoice engine for **clinic → patient/customer** billing: one
engine, many billable sources, country-configurable tax, immutable issued
documents, generic document storage.

Living document. Every phase appends a section: Completed · Files changed ·
Database changes · API changes · Tests added · Known issues · Next phase.

**Status:** Phases 0–10 complete. **Phase 11 (S3 provider + final QA) is next.**
See the phase table in 0.8 for the whole plan and what is deferred.

---

## Resuming this work in a new session

**Read, in this order:** `CLAUDE.md` → this file's §0 (the analysis: what
already exists, and the decisions that shape everything) → §0.8 (the phase
table) → the last completed phase's section → "Next phase" at the bottom of it.

### State of the tree

⚠️ **Nothing is committed.** All of Phases 0–1 sits as uncommitted working-tree
changes on `feat/phase-3-clinical-core`. Confirm with `git status` before
assuming a clean base; the migration below is already **applied** to the running
development database, so a `git checkout` of the schema without a database reset
would leave the two disagreeing.

**Phase 4 added no migration** — it is arithmetic against columns Phase 3 already
created. **Phase 5's migration adds no table and no column either**: it is three
trigger functions and five triggers, which `prisma migrate diff` cannot see and
will not warn you about. Applied migrations:
`20260809210000_document_storage_metadata`,
`20260809230000_issuer_tax_registrations_and_rules`,
`20260810090000_country_neutral_tax_lines`, `20260810120000_tax_rule_defaults`,
`20260810150000_patient_invoices`,
`20260811090000_invoice_lifecycle_immutability`,
`20260811120000_invoice_document_template_provenance`.

**Phase 6's migration adds two columns and no table**, so `db:rls:check` is
unchanged — but it also puts **Chromium in the worker container**, which is a
`docker compose build` rather than anything the lockfile records. A worker that
cannot launch a browser is a worker whose image predates Phase 6.

**Phase 8 adds no migration and no permission code either** — the rate card it
reads (`doctor_branch_settings.consultation_fee` and friends) has been in the
schema since the doctors phase with nothing consuming it, and the two routes sit
behind `billing.invoice.read` / `.create`. A database that is current for Phase 7
is current for Phase 8.

**Phase 9 adds no migration either**, but it DOES add a `setting_definitions` row
(`billing.cash_rounding_minor`) and two permission codes (`billing.tax.read`,
`billing.tax.manage`), all three written by the seed. Re-run it: a database that
predates the phase has them missing rather than wrong, and the symptoms are an
accountant who cannot open the tax screen and a clinic whose cash rounding falls
back to none. ⚠️ It also REMOVES `cashRoundingMinor` from three request bodies —
see the Phase 9 decisions for why a value that could not survive finalisation had
to leave the wire.

**Phase 10 adds nothing to the database at all** — no migration, no permission
code, no seed row. `audit_logs` has carried every column it writes since the
platform's first migration and `audit.record.read` has existed as long. A
database current for Phase 9 is current for Phase 10, with no caveat.

**Phase 7 adds no migration at all** — it is a surface on the model Phases 3–6
built. It does add one permission code, `billing.invoice.read_all`, which the
seed writes into `permissions` and `role_permissions`: a database that predates
it has the code missing rather than wrong, and the symptom is an accountant who
cannot see the pharmacy's invoices. Re-run the seed.

### The four things most likely to trip up a fresh session

1. ⚠️ **There are two different "invoices" in this repo.** `subscription_invoices`
   is rcln billing the clinic and is COMPLETE — do not touch it, do not extend
   it, do not merge the new engine into it. See §0.1 for why they cannot share a
   table. New work goes in `invoices` / `services/invoicing/`.
2. ⚠️ **Do not rebuild what exists.** `issueNumber()`, the tax engine in
   `@rcln/billing`, `@rcln/payments`' money primitives and the `billing.invoice.*`
   permission codes are all already there. §0.2 lists exactly what to reuse.
3. ⚠️ **Lab / pharmacy / inventory do not exist** and their invoice integrations
   cannot be built (§0.3). Do not invent `pharmacy_sales` or `lab_orders`.
4. ⚠️ **Three deliberate deviations from the original brief**, all reasoned and
   all easy to "fix" back into being wrong: invoice-level discount is
   apportioned onto lines BEFORE tax (§0.5), the invoice number carries the
   BRANCH CODE (§0.6, amended in Phase 3), and module-scoped invoice visibility
   is a derived source set rather than one permission code per source (§0.7).

### Commands that actually work here

⚠️ `pnpm validate` inside the **running** `api` container exits 137 (OOM) —
turbo fans out 15 tasks in a 1g container that is also running the dev server.
It is not a code failure. Use a dedicated container and serial execution:

```bash
# typecheck + lint, whole repo
docker compose run --rm --no-deps api sh -c 'pnpm exec turbo run typecheck lint --concurrency=1'

# API tests (666 at time of writing) — --runInBand for the same reason
docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --silent'

# one suite
docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration/documents.test.ts --runInBand'

# the web app, which turbo's typecheck+lint does NOT cover for build errors
docker compose run --rm --no-deps web sh -c 'cd apps/web && npx tsc --noEmit'
docker compose run --rm --no-deps web sh -c 'cd apps/web && npx eslint src --max-warnings 0'
docker compose run --rm --no-deps -e NEXT_TELEMETRY_DISABLED=1 web sh -c \
  'cd apps/web && npx next build'   # ⚠️ fails on the marketing sandbox page; see Phase 9

docker compose exec api pnpm --filter @rcln/db run rls:check   # 42 tables
cd packages/storage && pnpm test                                # 34 tests, runs on the host

# LOOK at the invoice template — renders the sample documents to HTML.
docker compose exec worker sh -c \
  'cd packages/documents && pnpm build && node scripts/preview.mjs /tmp/preview'

# The typefaces are GENERATED. Never hand-edit src/fonts.generated.ts; it is
# excluded from eslint for the same reason, because `--fix` reformats it and the
# freshness check then fails on a file nobody touched.
docker compose exec api pnpm --filter @rcln/documents run fonts:check

# Stored documents are REAL FILES ON THE HOST, outside the repo:
ls -R "${STORAGE_LOCAL_PATH:-$HOME/rcln/documents}"
```

⚠️ Running `prisma generate` while the dev server is up wedges the tsx watcher
and leaves the api container **unhealthy** with no error — `docker compose
restart api` fixes it. Check `docker compose ps` before concluding anything is
broken.

⚠️ `prisma migrate dev` fails in this environment (non-interactive). Write the
migration by hand: `prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script`, review it, put it in a timestamped folder, then
`prisma migrate deploy`.

⚠️ **Do not run `perl -0pi -e 's|...|...|'` over markdown here.** The `|`
delimiter collides with table pipes and silently duplicates the file into
something enormous. This document was destroyed that way once and rewritten from
scratch. Use the Edit tool.

### Green baseline to return to

847 API tests · 63 tax-package · 35 invoicing-package · 34 storage-package ·
40 billing-package · 21 documents-package · 10 queue-package · 39 permissions ·
95 payments tests · `db:rls:check` at 48 protected tables · repo-wide typecheck
and lint clean (34 turbo tasks, plus `apps/api`'s two `tsc` passes run
separately) · api and worker containers healthy.

⚠️ `next build` is NOT part of this baseline and currently FAILS, on
`/(marketing)/billing/sandbox` — a prerender error unrelated to the invoice work
(see Phase 9's known issues). It is worth knowing that a clean typecheck says
nothing about a production build: Phase 9 found `react-dom/server` in a Server
Component only by running one.

⚠️ The full API suite in ONE jest process is now killed by the container's
memory limit — 28 suites is past what a 1g container running the dev server can
hold, and it reports as `Killed` with no failing test. Not a code failure. Split
it, and raise the heap:

```bash
docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=3072" \
   npx jest tests/unit tests/integration/a tests/integration/b tests/integration/c \
   tests/integration/de tests/integration/do tests/integration/i --runInBand --silent'   # 537

docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=3072" \
   npx jest tests/integration/n tests/integration/p tests/integration/r \
   tests/integration/s tests/integration/t tests/integration/v --runInBand --silent'     # 310
```

⚠️ The package suites need `NODE_OPTIONS=--experimental-vm-modules`, which their
own `test` script sets — `npx jest` alone in a package directory fails every
suite with zero tests run and looks like a code failure:

```bash
docker compose run --rm --no-deps api sh -c \
  'for p in tax invoicing billing storage; do (cd packages/$p && \
   NODE_OPTIONS=--experimental-vm-modules npx jest --silent); done'
```

⚠️ `apps/api`'s `typecheck` script runs `tsc` twice and the second pass —
`tsconfig.test.json`, which now compiles 25 test suites — OOMs at the container's
default heap. Not a code failure:

```bash
docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS=--max-old-space-size=3072 npx tsc -p tsconfig.test.json'
```

⚠️ `pnpm --filter @rcln/billing test` fails **on the host** with `Cannot find
module '@prisma/client-runtime-utils'` — a host/container `node_modules`
difference, not a code failure. Run it in the container. `@rcln/tax` and
`@rcln/storage` have no Prisma dependency and run fine on the host.

---

## Phase 0 — Existing system analysis

Read before designing anything. The conclusion is that roughly half of what the
brief asks for already exists in this repository under a different name, and one
of the things it asks for collides with an existing subsystem in a way that will
cause real damage if the two are conflated.

### 0.1 The collision: there is already an "invoice", and it is the wrong one

`subscription_invoices` / `subscription_invoice_lines` exist and are complete
(Phase 2, shipped). They are **rcln billing the clinic** for its SaaS
subscription:

| Aspect           | `subscription_invoices` (exists)                         | the engine this brief asks for               |
| ---------------- | -------------------------------------------------------- | -------------------------------------------- |
| Supplier         | rcln (the platform)                                      | the clinic (the tenant)                      |
| Customer         | the organization                                         | a patient / walk-in customer                 |
| Tax registration | **rcln's own**, in the platform-wide `tax_registrations` | **the clinic's own** — does not exist yet    |
| Place of supply  | the _customer_ (OIDAR / digital services rule)           | the _branch_ (services performed at a place) |
| Number format    | `INV-2026-4F73C7-000012` (org id fragment)               | `INV-2026-APP-000001` (source code)          |
| Sequencing       | count-and-retry on a unique index                        | must be `issueNumber()` — gapless, atomic    |
| Money type       | integer minor units through `@rcln/payments`             | same (see 0.4)                               |
| Lifecycle        | DRAFT → OPEN → PAID → VOID, gateway-driven               | DRAFT → ISSUED → PAID/…, cashier-driven      |
| RLS              | org-scoped                                               | org-scoped **plus branch-scoped**            |

They are two different documents with two different issuers and two different
legal obligations. **They must not be merged and must not share a table.**

Naming decision to carry through every phase: the new tables are `invoices`,
`invoice_items`, `invoice_taxes`, `invoice_documents`; the existing ones keep
their `subscription_` prefix. In code, the new engine lives under
`services/invoicing/` and the existing one stays in `services/billing/`. Where a
screen or a permission could mean either, it says _subscription invoice_ or
_patient invoice_ explicitly.

### 0.2 What already exists and will be reused, not rebuilt

**`issueNumber()` — `apps/api/src/services/numbering/`.** Exactly the
concurrency-safe sequencer §2 of the brief demands, already built and already
measured (50 parallel issues return 1..50; the naive read-then-write it replaced
returned 7 distinct values out of 50). One `INSERT … ON CONFLICT DO UPDATE`
whose row lock is the serialisation point; transactional, so a rolled-back
invoice does not burn a number. Deliberately **not** a Postgres `SEQUENCE`
(`nextval` is non-transactional, and one sequence object per tenant is runtime
DDL `rcln_app` cannot execute).

The brief's `INV-{YEAR}-{SOURCE}-{SEQUENCE}` maps onto it with **no change to
the mechanism** — it already generalises the reset cadence into a `period_key`.
Only a new `NumberSequenceType` enum value (`INVOICE`) is needed. See 0.6 for
the decided key shape.

⚠️ `number_sequences` carries **org-scoped RLS only, deliberately** — a
`branch_isolation` policy there turns `ON CONFLICT DO UPDATE` against a hidden
row into a 23505 at the moment of billing. Do not "fix" it.

**The tax engine — `packages/billing/src/tax/engine.ts`, 451 lines.** Already
architecturally what §8/§9 ask for, and already resists the exact mistake the
brief warns about:

- It starts from _"do we hold a registration here?"_, not _"what rate?"_, and
  returns `NOT_REGISTERED` (zero tax, reason recorded) when nothing covers the
  place of supply.
- India GST is implemented properly — CGST/SGST intra-state, IGST inter-state,
  halves that sum exactly, zero-rated exports.
- VAT does reverse charge on a **validated** number only.
- EU cross-border consumer VAT and US sales tax deliberately **refuse to guess**
  and return nothing charged with a reason naming the missing tax provider.
- Rates are basis points (integers), amounts are `Money`, nothing is a float.
- `TaxTreatment`, `TaxIdStatus`, `TaxScheme`, `TaxBehavior` enums all exist.

**But it cannot be used as-is for patient billing**, for two reasons that are
the substance of Phase 2:

1. `tax_registrations` is a **platform-wide table with no `organization_id`** —
   it holds _rcln's_ GSTINs, managed from the platform console under
   `platform.tax.manage`. Patient billing needs the _clinic's_ GSTIN, per state.
   That is a new org-scoped table, not a column on the existing one.
2. It carries **one `standard_rate_bps` per registration**. That is honest for
   selling one product (SaaS) but wrong for patient billing, where the rate is a
   property of the _item_: in India consultation is exempt, medicines are 5% or
   12%, and most consumables are 12% or 18%, all keyed by HSN/SAC. This is where
   the brief's effective-dated `tax_rules` table earns its place.

The plan is therefore to **extract the engine to `packages/tax/`** behind the
same `resolveTax`-shaped interface it already has (the file header already
anticipates this move), generalise the supplier from "rcln" to "an issuer", and
add per-item rate resolution. The subscription path keeps working against the
same interface.

**`@rcln/payments` money primitives.** `Money` = `{ amountMinor: integer,
currency }`, with `addMoney` / `subtractMoney` / `scaleMoney` / `divideRounded`
and an **explicit rounding mode on every division** — no silent `Math.round`.
`minorUnitExponent()` gives per-currency precision, so §37's `currency_precision`
is already solved and JPY/KWD work. This satisfies §7 and §38 outright and there
is no reason to add decimal.js.

**Permission codes.** `billing.invoice.read` / `.create` / `.update` / `.cancel`,
`billing.payment.collect`, `billing.credit_note.issue`, `billing.refund.process`
already exist in `packages/permissions/src/codes.ts` and are already granted per
role across the 12 system roles. They were seeded for exactly this work.

⚠️ **They are not sufficient as they stand** — see 0.7.

**`files` / `StoredFile` model.** The table existed (`storage_key`, `mime_type`,
`size_bytes`, `checksum`, `uploaded_by`, org + branch) with **no code behind it
at all** — no upload, no download, no provider, no service. Phase 1 built that.

**Everything else the brief assumes.** `withTenant()`, composite FKs, the RLS
gauntlet + `db:rls:check`, `audit_logs` (append-only, two independent layers),
`data_access_logs` (PHI reads), `resolveSettings()`, Zod contracts in
`@rcln/contracts`, the middleware chain, BullMQ (registered, stubs only),
`formatClinicTime`.

### 0.3 What does not exist

| Brief phase                              | Reality                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| §11 / Phase 10 — Pharmacy                | **Module does not exist.** Roadmap Phase 5. No medicines, no batches, no sales.    |
| §12 / Phase 9 — Lab                      | **Module does not exist.** Roadmap Phase 6. No tests, no orders, no results.       |
| §14 / Phase 11 — Inventory & procurement | **Module does not exist.** Roadmap Phase 5. No suppliers, no POs, no stock ledger. |
| §15 — Consumables                        | Depends on inventory. Does not exist.                                              |
| §22 / Phase 6 — PDF                      | No PDF library, no renderer, no template anywhere in the repo.                     |

**Appointments do exist and are complete** — `appointments`,
`appointment_vitals`, `appointment_status_history`, the availability engine, the
day board, the follow-up chain. So `APPOINTMENT` is the one source that can be
integrated end to end today.

Consequence: brief Phases 9, 10, 11 and the pharmacy/lab halves of 13 **cannot
be implemented** — there is no `pharmacy_sales` or `lab_orders` table for an
invoice to reference, and inventing those tables here would be building the
pharmacy and lab modules by the back door, badly, with no domain work behind
them. ⚠️ **Amended in Phase 3:** that includes inventing them as ID-only stubs
so a foreign key can exist early. See the Phase 3 decisions for why a stub with
no `organization_id` closes the wrong half of the problem, and one with an
`organization_id` is simply the real table designed by the wrong person at the
wrong time.

This is not a reason to narrow the engine. `source_type` ships as a full enum
including `LAB`, `PHARMACY`, `INVENTORY`, and the source-code registry ships
with `LAB`/`PHA`/`INV` mapped, so those modules land as integrations rather than
as a redesign. What ships as _working_ is `APPOINTMENT`, `PROCEDURE`, `SERVICE`,
`OTHER`, and a manual invoice path that exercises every part of the engine.

### 0.4 Decision — money representation

`numeric(14,2)` columns in Postgres (matching `subscription_invoices` and every
other money column in the schema); `Money` integer minor units in the
calculation engine; conversion at the persistence boundary only, in one place.

This is the existing convention, not a new one. `@rcln/payments/money.ts` states
the reasoning: `numeric` is the right shape for a ledger and the wrong shape for
arithmetic that divides, because `4999.995` is representable in `numeric` and
chargeable by nobody. Discounts and percentage tax both divide.

**No decimal.js.** Adding a second money representation to a codebase that
already has a considered one is worse than either.

### 0.5 Decision — calculation order (§7)

Fixed and documented once, applied everywhere, with each step rounded to the
currency's minor unit before the next reads it:

```
line.gross          = round(unit_price × quantity)
line.discount       = round(percentage ? gross × pct : fixed)
line.taxable        = gross − discount
line.tax[]          = per applicable rule: round(taxable × rate_bps / 10000)
line.total          = taxable + Σ tax

invoice.subtotal    = Σ line.gross
invoice.line_disc   = Σ line.discount
invoice.taxable     = Σ line.taxable
invoice.tax_total   = Σ Σ line.tax
invoice.inv_disc    = invoice-level discount, apportioned across lines pro-rata
                      by taxable amount, largest-remainder so the parts sum exactly
invoice.rounding    = grand_total_rounded − grand_total_raw
invoice.grand_total = subtotal − discounts + tax + rounding
```

⚠️ **Invoice-level discount is apportioned back onto lines before tax, not
subtracted after it.** The brief's §7 sketch puts it after tax. That is wrong
for any VAT/GST regime — a discount that reduces what the customer pays reduces
the taxable value of the supply, and tax computed on the pre-discount amount is
over-collected tax remitted to an authority on money nobody received. The
apportionment is largest-remainder so the parts sum to the whole exactly. This
deviation from the brief is deliberate and is recorded here rather than
silently.

⚠️ **Tax is rounded per line, not per invoice.** Both are defensible and they
differ by up to (n−1) minor units; per-line is what Indian GST invoices do and
what makes each printed line internally consistent.

### 0.6 Decision — invoice number scope

`INV-{YEAR}-{SOURCE}-{SEQUENCE}` fixes the _shape_ but not the _scope_, and the
scope is a one-migration-if-wrong decision:

- **Reset cadence** — calendar year vs Indian financial year (what GST actually
  requires of an Indian clinic, and what appointment numbers here already use).
- **Uniqueness scope** — per organization vs per branch. GST requires a series
  unique per _issuer_, and the issuer is the GSTIN, which in India is per state
  — so a hospital group with branches in two states legally needs two series.

**Decided (2026-08-09): per branch, cadence resolved from the issuer's
country** — financial-year reset for `IN`, calendar-year elsewhere. The cadence
is looked up, never hard-coded; hard-coding either one is the "do not assume
India" failure of §8 in reverse. Carrying `branch_id` in the sequence key costs
nothing for a single-branch clinic and cannot be retrofitted once numbers are
issued.

```
sequence_type = INVOICE
branch_id     = <issuing branch>
period_key    = '2026-27:APP'   (IN — financial year)
period_key    = '2026:APP'      (elsewhere — calendar year)
prefix        = 'INV-2026-APP-MAIN-'
```

⚠️ **AMENDED IN PHASE 3: THE BRANCH CODE IS IN THE NUMBER.** The two decisions
above — a per-branch series, and the brief's `INV-{YEAR}-{SOURCE}-{SEQUENCE}`
shape — are a compliance failure when taken together, and this section shipped
without noticing. Two branches in the same state share one GSTIN, both counters
start at 1, and both issue `INV-2026-APP-000001`. GST permits several series
under one registration; it does not permit a repeated number. The format is
therefore `INV-{PERIOD_YEAR}-{SOURCE}-{BRANCH_CODE}-{000001}`, and because
branch codes are org-unique the whole string is unique org-wide — stronger than
the law asks, and what `invoices.invoice_number`'s unique index relies on.

⚠️ The `{YEAR}` printed in the number is the **start year of the period**, so an
Indian invoice issued in February 2027 within FY 2026-27 reads `INV-2026-…`.
That is what makes the series contiguous within the return period it belongs to;
a number that flipped to `INV-2027-` on 1 January would split one financial
year's series in two.

### 0.7 Gap — module-scoped invoice permissions (§17, §46)

The brief requires that a pharmacist see pharmacy invoices and not lab invoices.
The existing codes are `billing.invoice.read` — one code, all sources. A
pharmacist holding it sees everything.

Adding `pharmacy.invoice.read` / `lab.invoice.read` / … as parallel codes gives
12 roles × 7 sources of matrix to maintain and no clean answer for a role that
should see all of them.

Design instead: keep `billing.invoice.read` as the gate on the _surface_, and
resolve **which sources a caller may see** as a derived set, the same way
`doctor.directory.read` already decides whether a caller may read across
practitioners (Stage 4b). One rule, consulted by the list query, the detail
route and the PDF route alike — not three. The full-visibility case is a
separate code (`billing.invoice.read_all`) rather than an enumeration of every
source, so a new source does not require re-granting anything.

⚠️ Enforced in the **query**, not the route guard — a source filter the caller
can pass is not a boundary. Same failure shape as the `?doctorProfileId=`
override in Stage 4b, and it gets the same treatment.

### 0.8 Revised phase plan

Renumbered against what this repository actually contains. Every phase leaves
typecheck, lint, tests and `db:rls:check` green.

| #   | Phase                     | Brief §              | Status                               |
| --- | ------------------------- | -------------------- | ------------------------------------ |
| 1   | Storage + DocumentService | 24–31, 42            | **Done**                             |
| 2   | Tax engine generalisation | 8–10, 2              | **Done**                             |
| 3   | Invoice data model        | 3, 19–21, 51         | **Done**                             |
| 4   | Calculation engine        | 6, 7, 37, 38         | **Done**                             |
| 5   | Lifecycle + immutability  | 5, 36, 40            | **Done**                             |
| 6   | Document rendering        | 22, 23, 43, 44       | **Done**                             |
| 7   | Invoice APIs              | 32–34, 39            | **Done**                             |
| 8   | Appointment billing       | 13                   | **Done**                             |
| 9   | Frontend invoice module   | 45                   | **Done**                             |
| 10  | Audit                     | 35                   | **Done**                             |
| 11  | S3 provider + final QA    | 15, 16, 52           | —                                    |
| —   | _Deferred_                | 9, 10, 11, 13 (part) | Blocked on modules that do not exist |

Detail on each:

- **Phase 2** — extract `packages/billing/src/tax/` to `packages/tax/` behind
  its existing interface; org-scoped issuer registrations; effective-dated
  `tax_rules` keyed by item tax category. The subscription path must keep
  working against the same interface — that is the test that the extraction was
  real.
- **Phase 3** — `invoices`, `invoice_items`, `invoice_taxes`,
  `invoice_documents`; RLS (org + branch), composite FKs, `INVOICE` sequence
  type, indexes. Uses the 0.6 decision.
- **Phase 4** — pure functions, no I/O. The order in 0.5, largest-remainder
  apportionment, per-currency precision. ⚠️ **Landed in a new
  `packages/invoicing/`, not in `packages/billing`** — see the Phase 4 decisions
  for why this line as written contradicted §0.1.
- **Phase 5** — DRAFT → FINALIZING → ISSUED → PAID/…; issued financials
  immutable at the **database**, not only in the service. Cancel and void.
  ⚠️ **Credit note deferred** — no table, no series, no `CREDIT_NOTE` source
  type, and nothing that could consume one until Phases 6 and 7. See the Phase 5
  decisions.
- **Phase 6** — ⚠️ **NOT three layers in the end, and not a PDF library.** The
  requirement is that the screen and the printed document are the SAME document,
  which a drawing library plus a matching React screen cannot give you — those
  are two templates kept alike by hand. It is one function producing one
  self-contained HTML string, rendered in an iframe by the web and by Chromium in
  the WORKER, which is where the browser has to live because the api container is
  capped at 1g. Generated once at issue, stored via DocumentService, never
  regenerated on download.
- **Phase 7** — list/detail/PDF/create/finalize/cancel. Pagination, filters, the
  0.7 visibility rule, typed errors.
- **Phase 10** — ⚠️ No PHI on an audit row; the allow-list snapshot discipline
  from Stage 3 applies.

### 0.9 Files read during analysis

`packages/db/prisma/schema.prisma` (2837 lines, 84 models/enums) ·
`packages/billing/src/{numbering,tax/engine}.ts` ·
`packages/payments/src/money.ts` ·
`packages/permissions/src/{codes,roles}.ts` ·
`apps/api/src/services/numbering/` · `apps/api/src/routes/v1/index.ts` ·
`.kb/STATUS.md` · `CLAUDE.md`

---

## Phase 1 — Document & storage infrastructure

**Complete.** 666 API tests green (was 651), 34 storage-package tests green,
`db:rls:check` green at 42 protected tables, repo-wide typecheck and lint green.

### Completed

- **`@rcln/storage`** — a new workspace package holding the whole storage seam.
  `StorageProvider` (6 methods), `LocalStorageProvider`, key construction and
  validation, a typed error set, and a config-driven factory. No Prisma, no
  Express, no knowledge of tenants.
- **`DocumentService`** (`apps/api/src/services/document/`) — generic over
  document type, as §31 requires. Nothing in it names an invoice.
- **`files` is now the generic document table** — `document_type`, `status`,
  `storage_provider`, `version`, `failure_reason`, plus the composite-FK target
  Phase 3 will reference.
- **Configuration, gitignore, compose and `.env.example`** wired for §29/§30.
- **S3 is designed, not built** — the factory throws a named error rather than
  falling back, and Phase 11 implements `providers/s3.ts` behind the same
  interface with no change above it.

### Decisions worth knowing about

⚠️ **Three independent layers stop a storage key escaping the root**, and the
third is not redundant. `assertValidKey` refuses traversal segments; a lexical
`resolve` + prefix check catches anything that bypassed it; and a **real-path
check** catches the case neither can see — a key of entirely well-formed
segments whose _directory_ is a symlink. **Measured**: with layer 3 removed,
exactly one test fails, and it is the symlink one. Both prefix comparisons use
the real path of the root as well, because on macOS `os.tmpdir()` is
`/var/folders/…` whose real path is `/private/var/…`.

⚠️ **`getSignedUrl` returns `null` on local disk, and that is a real answer.**
Local storage has no URL space; inventing one would be a second authorization
system beside the working one. The download route branches on null and streams
the bytes itself — which it must be able to do anyway, because that is the path
that enforces RBAC. A signed URL is therefore an optimisation, never a boundary.

⚠️ **Duplicates are refused by `files.storage_key`'s UNIQUE, not by the storage
provider.** The row is claimed before the bytes are written, so the provider's
own overwrite guard never fires. The raw Prisma `P2002` is translated to a
`DocumentError` — letting it through would put a Prisma code and a column name
on an API response (§39). Found by a test that expected the wrong error.

⚠️ **The explicit `organizationId` pin in `getDocument` is load-bearing, and RLS
does not cover it.** `files`' policy permits a NULL `organization_id` so that
platform assets are readable by every tenant — correct for a platform asset, and
a hole for anything else. **Measured**: with the pin removed, the cross-tenant
test still passes (RLS catches that one) and _only_ the platform-document test
fails. The pin's entire job is that one case.

⚠️ **Order of operations: row → bytes → READY.** Each of the three crash windows
is survivable and none of them produces a document the system swears exists and
cannot serve. The inverse order does, and its failure mode is discovered by a
patient at the front desk.

⚠️ **The checksum is verified on read**, not only on write. Storage is a folder
a person can write to. **Measured** by corrupting the file on disk.

⚠️ **The storage write is outside the transaction**, deliberately — an S3 PUT
does not roll back with Postgres, so holding a transaction across it buys no
atomicity and costs a held connection. `status` is what reconciles the two.

#### Where documents live

⚠️ **`STORAGE_LOCAL_PATH` is the single source of truth, and compose uses that
one value on BOTH SIDES of a bind mount.**

```yaml
STORAGE_LOCAL_PATH: ${STORAGE_LOCAL_PATH:-${HOME}/rcln/documents}
volumes:
  - ${STORAGE_LOCAL_PATH:-${HOME}/rcln/documents}:${STORAGE_LOCAL_PATH:-${HOME}/rcln/documents}
```

Host folder and in-container path are identical, and the API and the worker
mount it the same way. So the variable alone moves the documents — no compose
edit, no second setting to drift — and a queued PDF generation in Phase 11
cannot land somewhere the API cannot read.

They are **real files on the host**, deliberately: a named volume is invisible
outside Docker, and the PDF renderer in Phase 6 is far easier to build when the
output can just be opened. Outside the repository, equally deliberately — an
invoice PDF names a patient, and a folder in a git working tree is one
`git add -f` from being published permanently.

⚠️ **Two ways to get the path wrong, and NEITHER RAISES AN ERROR:**

1. **A path Docker Desktop does not share.** `/var/lib`, `/opt`, `/srv` are not
   shared by default; anything under `$HOME` is. **Measured**: a bind mount of
   `/var/lib/rcln-mount-test` reported success, the container wrote the file
   happily, and nothing appeared on the host — Docker had created the directory
   inside its own Linux VM. This is why the default is under `$HOME` and not the
   FHS-correct `/var/lib/rcln`, which is what the layout would otherwise want.
2. **A path that only exists inside the container**, which loses every PDF on
   the next `--build` while the `files` rows survive.

⚠️ Compose requires the value to be **absolute** — a relative path cannot be a
mount target, and `docker compose up` fails with "invalid mount target".

**Verified end to end**, not reasoned about: written through the running API to
`~/rcln/documents/...`, present on the host owned by the developer (Docker
Desktop translates ownership, so it is not root-owned), read back by the
**worker** at the same path, a file created on the host visible inside both
containers, and a container-side delete removing it from the host.

⚠️ Consequence worth knowing: `docker compose down -v` does **not** delete
documents, unlike every other volume. Removing them is a host `rm`.

⚠️ **A relative `STORAGE_LOCAL_PATH` is resolved against the REPO ROOT, never
`cwd`** — this was a real bug, caught only by probing the running container
rather than by any test, because every test pointed storage at a temp directory.
The API server's working directory is `/app/apps/api` and the worker's is
`/app/apps/worker`, so a `cwd`-relative default gave the two processes different
storage roots and put both outside the `.gitignore` anchor. Compose now requires
an absolute path so this only affects a native run, but the rule still has to
hold there. The config module derives the repo root from its own
`import.meta.url` (the technique already used for `.env`) and anchors any
relative path to it; absolute paths pass through untouched. Pinned by
`apps/api/tests/unit/storage-path.test.ts` — measured: revert to
`resolve(value)` and exactly that one case fails.

### Files changed

- `packages/storage/**` — new package: `types`, `keys`, `errors`, `registry`,
  `providers/local`, plus 2 test files
- `packages/db/prisma/schema.prisma` — `DocumentType` + `DocumentStatus` enums;
  `StoredFile` extended
- `packages/db/prisma/migrations/20260809210000_document_storage_metadata/` — new
- `apps/api/src/services/document/document.service.ts` — new, generic
- `apps/api/src/services/document/storage.provider.ts` — new, the single
  memoised provider instance
- `apps/api/src/config/index.ts` — `storage` block, repo-root path resolution,
  the s3-without-a-bucket boot guard
- `apps/api/package.json` — `@rcln/storage` dependency
- `apps/api/tests/integration/documents.test.ts` — new, 13 cases
- `apps/api/tests/unit/storage-path.test.ts` — new, 2 cases
- `docker-compose.yml` — host bind mount driven entirely by
  `STORAGE_LOCAL_PATH`, identical path both sides, in api and worker
- `.gitignore`, `.env.example` — §29, §30. Documents live outside the repo, so
  the ignore rules are a safety net rather than the primary control

### Database changes

`files` gains `document_type` (enum, default `UPLOAD`), `status` (enum, default
`READY`), `storage_provider` (varchar, default `local`), `version` (smallint),
`failure_reason` (varchar 500); `size_bytes` gains a default of 0. Two new
indexes: `(organization_id, document_type, status)` and the unique
`(organization_id, id)` composite-FK target.

Additive only, no backfill — every pre-existing row is an upload that already
has its bytes, which the defaults describe correctly. No new table, so no new
RLS policy: `files` already carried `tenant_isolation` and `db:rls:check` was
already counting it.

### API changes

None. Phase 1 is infrastructure; no route was added or altered.

### Tests added

- `packages/storage/tests/keys.test.ts` — 21 cases, mostly traversal.
- `packages/storage/tests/local-provider.test.ts` — 13 cases, including the
  symlink escape and the sibling-directory prefix.
- `apps/api/tests/integration/documents.test.ts` — 13 cases against real
  Postgres and a real filesystem: round-trip, the FAILED row, the corrupted
  file, the vanished file, cross-tenant read, and the platform-document hole.
- `apps/api/tests/unit/storage-path.test.ts` — 2 cases pinning the storage root.

### Known issues

- **The S3 provider does not exist.** `STORAGE_PROVIDER=s3` is a fatal boot
  error by design. Phase 11.
- **Nothing writes a document yet.** `DocumentService` has no caller until
  Phase 6 generates the first PDF; it is exercised only by its tests.
- **No cleanup for stuck `GENERATING` rows.** A crash between the row and the
  write leaves one, and nothing sweeps them. Harmless today but it wants a job
  once PDF generation moves to the queue in Phase 11.
- **No `deleteDocument`.** Deliberate — nothing should be deleting an issued
  invoice's PDF, and the DPDP anonymisation routine that legitimately needs
  prefix deletion does not exist yet (see `.kb/STATUS.md`, "Blocked").
- **The cross-process half of the storage path is unpinned.** That the worker
  resolves the same absolute path needs the worker booted, which belongs in an
  e2e suite. It matters from Phase 11.
- ⚠️ **Running `pnpm validate` inside the running `api` container OOMs**
  (exit 137). Not a code problem — see the resume section for what works.
- Pre-existing schema drift, unrelated and untouched: `prisma migrate diff`
  reports two `appointment_vitals` constraint/index renames left by
  `20260809180000_vitals_revisions`.

### Next phase

**Phase 2 — tax engine generalisation.** Done; see below.

---

## Phase 2 — Tax engine generalisation

**Complete.** 683 API tests green (was 666), 32 tax-package tests, 40
billing-package tests, `db:rls:check` green at 44 protected tables, repo-wide
typecheck and lint green.

### Completed

- **`@rcln/tax`** — a new workspace package holding the whole tax seam, split
  out of `@rcln/billing`. Depends on `@rcln/payments` and nothing else: no
  Prisma, no Express, no clock beyond the `suppliedAt` the caller passes.
- **The supplier is now an issuer.** `SupplierRegistration` → `IssuerRegistration`,
  and every string that read as "rcln" is gone from the engine. Two tables feed
  the same interface: `tax_registrations` (rcln, platform-wide, RLS-exempt) and
  the new `issuer_tax_registrations` (the clinic, tenant-scoped).
- **Place of supply is an explicit input**, not a thing derived from the
  customer. See the decision below — this is the substantive behaviour change.
- **`tax_rules`** — effective-dated rates per item tax category, tenant-scoped.
- **`branches` learnt its jurisdiction** — `country_code` + `region_code`, ISO,
  beside the existing free-text `state`.
- **`TaxTreatment` gained `UNRATED`** — the one value that means _this document
  is not fit to issue_.
- **`loadTaxContext()` / `taxForItem()`** in `apps/api/src/services/invoicing/` —
  one database read per invoice, after which pricing every line is pure.

### Decisions worth knowing about

⚠️ **The extraction is proved by the tests that did NOT change.** All 18
subscription-path tax cases moved to `packages/tax/tests/tax.test.ts` and pass
with only the type rename applied — no assertion was touched. `@rcln/billing`
does **not** re-export the tax symbols: one symbol, one home, so nothing ends up
importing `TaxQuote` from two places.

⚠️ **Place of supply is now explicit, and omitting it is a decision.** The old
engine conflated "where the customer is" with "where the supply happens", which
is correct for a digital service (OIDAR / the EU's 2015 rule — what a
subscription wants) and wrong for a consultation, which is supplied where it was
performed. `TaxableSupply.placeOfSupply` is optional and defaults to the
customer, so every existing subscription path behaves identically; a patient
invoice passes the **issuing branch's** jurisdiction. Getting this backwards
bills a Karnataka clinic's consultation as an inter-state supply because the
patient lives in Kerala — IGST instead of CGST+SGST, and the state's half never
reaches the state. Pinned by a test in both directions.

⚠️ **A clinic registration carries NO standard rate, and the column does not
exist.** `IssuerRegistration.standardRateBps` is `number | null` and the service
maps it to `null` rather than `0`. Zero would read as "0% is the answer" and
silently untax any line whose category failed to resolve; null makes that line
`UNRATED`. There is deliberately nothing to fall back to.

⚠️ **A category with no rule is `UNRATED`, not the registration's rate.** The
single most important decision in the phase. There IS a valid registration and
there ARE other rules under it, so a fallback would be easy and would look
entirely right on the printed invoice — a rate nobody chose, on a document a
patient may claim against insurance. The engine reports; **Phase 5's
finalisation must refuse to ISSUE an invoice carrying `UNRATED`**, and that is
the half that does not exist yet. `UNRATED` is deliberately distinct from
`NOT_REGISTERED`: the latter is a legal position and the invoice is fine, the
former is a configuration gap and the invoice is not.

⚠️ **`EXEMPT` is not `ZERO_RATED` and the difference is not cosmetic.** An
exempt supply carries no input credit and is reported differently. Healthcare
services in India are exempt, which makes it the single most common line on a
clinic's invoice — and charging GST on it means the clinic owes the government
money it should never have taken from the patient.

⚠️ **Three CHECK constraints do work the type system cannot.** `treatment` on
`tax_rules` is the full six-value enum because Prisma cannot express a subset of
one, so `tax_rules_treatment_is_item_level` is the only thing stopping a
catalogue row asserting `REVERSE_CHARGE` — a fact about two parties that a box
of paracetamol cannot possibly be. `tax_rules_untaxed_means_zero_rate` refuses
"EXEMPT at 18%", which is a typo that prints a self-contradicting invoice line.
The service casts to `ItemTaxTreatment` on the way out **trusting exactly
these**. All three are asserted in `tenant-isolation.test.ts` rather than
assumed.

⚠️ **Both unique keys need `NULLS NOT DISTINCT`, and country-wide is the COMMON
case here** — a GST rate is national even though the registration is per state.
Prisma emits an ordinary unique index, which does not constrain NULL
`region_code` at all, so without the hand-appended replacement a clinic can hold
five country-wide rules for one category and the engine takes whichever the
planner returned first.

⚠️ **Overlapping rules break on the latest `effective_from`.** The unique key
stops two rules starting on the same day; it cannot stop overlapping _ranges_,
and the ordinary way to produce one is to add a rate change and forget to close
the previous row. Without a deterministic tie-break the same item is taxed at
12% on Monday and 5% on Tuesday with nothing in the data having changed.

⚠️ **These two tables take the OPPOSITE RLS decision from `tax_registrations`,
and the reasoning does not transfer.** That table is exempt because it holds
rcln's numbers and is read inside a tenant transaction: a policy on it returns
zero rows, zero rows reads as `NOT_REGISTERED`, and every subscription invoice
silently comes out untaxed. These rows belong to the organization reading them,
so an ordinary `tenant_isolation` policy returns exactly the right set. Someone
who knows the exemption and not the reason for it could plausibly exempt these
too and **nothing would fail** — a clinic would simply start reading its
competitor's GSTIN and whole rate card. Both directions are pinned: the
cross-tenant cases in `tenant-isolation.test.ts`, and a case in
`invoicing-tax.test.ts` asserting the issuer really can still see its own rows
through the policy.

⚠️ **Cross-tenant rate leakage is asserted as an arithmetic claim, not a row
count.** In `invoicing-tax.test.ts` org A taxes `MEDICINE` at 5% and org B at
18%. A leak shows up as `18000` where `5000` was expected — a count-the-rows
assertion would not necessarily notice.

⚠️ **`branches.region_code` was backfilled from the organization.** Right for
the single-state clinic, which is nearly all of them, and wrong for the group
that opened a second branch in another state. It cannot be inferred:
`branches.state` is free text written for an address label, and "Karnataka",
"KARNATAKA" and "Karnatak" are three lookup keys. **Nothing yet forces a clinic
to correct it** — Phase 5's finalisation is where that check belongs.

⚠️ **`loadTaxContext` refuses a branch it cannot see rather than falling back.**
Under RLS another tenant's branch id is indistinguishable from one that does not
exist. Falling back to the organization's own jurisdiction would bill under the
wrong state's GSTIN and look entirely plausible on the printed invoice.

⚠️ **Category matching is exact — there is no HSN prefix tree, deliberately.** A
prefix match that silently resolved `30049099` to the broader `3004` heading
would apply a confident, unreviewed rate.

### Files changed

- `packages/tax/**` — new package: `types`, `arithmetic`, `selection`, `engine`,
  `index`, plus 2 test files
- `packages/billing/src/tax/engine.ts` — **deleted**; `index.ts`, `engine/shared.ts`
  and `engine/lifecycle.ts` now import from `@rcln/tax`
- `packages/billing/tests/tax.test.ts` → `packages/tax/tests/tax.test.ts`
- `packages/db/prisma/schema.prisma` — `UNRATED` on `TaxTreatment`;
  `IssuerTaxRegistration` + `TaxRule` models; `Branch.countryCode` /
  `.regionCode`
- `packages/db/prisma/migrations/20260809230000_issuer_tax_registrations_and_rules/` — new
- `packages/db/prisma/rls/enable-rls.sql` — both tables into `org_scoped`
- `apps/api/src/services/invoicing/tax.service.ts` — new
- `apps/api/tests/integration/invoicing-tax.test.ts` — new, 9 cases
- `apps/api/tests/integration/tenant-isolation.test.ts` — 8 new cases
- `packages/billing/package.json`, `apps/api/package.json` — `@rcln/tax`
- `.kb/modules.json` — the `Tax` module entry

### Database changes

Two new tenant tables, both with `tenant_isolation` RLS, a composite-FK target
`(organization_id, id)`, and hand-appended SQL: `NULLS NOT DISTINCT` on the
nullable-region unique keys, the three CHECK constraints, and an effective-range
CHECK on each. `branches` gains `country_code` (default `IN`) and `region_code`,
backfilled from the organization. `TaxTreatment` gains `UNRATED`.

`db:rls:check` goes from 42 to 44 protected tables.

### API changes

None. Phase 2 is resolution, not administration — no route was added or altered.

### Tests added

- `packages/tax/tests/tax.test.ts` — the 18 subscription cases, moved and
  otherwise unchanged, plus 1 pinning the place-of-supply default. This suite
  passing untouched is the evidence the extraction was behaviour-preserving.
- `packages/tax/tests/rules.test.ts` — 13 cases: exempt consultations, per-item
  rates under one registration, `UNRATED`, the branch as place of supply,
  effective-dating, overlap tie-breaks, exact category matching.
- `apps/api/tests/integration/invoicing-tax.test.ts` — 9 cases against real
  Postgres: the place of supply read from a branch row, a two-state group
  billing under two GSTINs, both directions of cross-tenant rate leakage, and a
  registration not yet in force.
- `apps/api/tests/integration/tenant-isolation.test.ts` — 8 cases: fail-closed,
  cross-tenant read of registrations and rules, the WITH CHECK write, and all
  three hand-written constraints.

### Known issues

- **No management API or screen.** `issuer_tax_registrations` and `tax_rules`
  are written by seed or by hand until Phase 7. No permission codes were added
  either — an unused code is speculative config, and the seeder rebuilds the
  role matrix from `codes.ts` on every run, so adding them with the routes costs
  nothing.
- **No default rate card is seeded for a new organization.** A clinic that
  registers today has no rules, so every line would come back `UNRATED`. Whether
  rcln ships an opinionated Indian starter card or makes the clinic enter its
  own is a product decision, not a technical one, and it belongs with Phase 7's
  administration screen.
- ⚠️ **`UNRATED` is reported and not yet refused.** The finalisation guard is
  Phase 5. Until it exists nothing stops a caller issuing an untaxed invoice.
- ⚠️ **A multi-state group's second branch carries the wrong `region_code`**
  until someone edits it, and nothing prompts them. See above.
- **`taxForItem` has no caller.** Phase 4's calculation engine is the first;
  today it is exercised only by its integration tests. Same shape as
  `DocumentService` at the end of Phase 1.
- **The customer's tax id is passed as `UNVALIDATED`** whenever one is given.
  Correct — an unchecked number is a number somebody typed — but there is no
  validation path, so a B2B patient invoice can never reach reverse charge. Not
  needed for Indian healthcare; it matters if this engine is ever pointed at a
  VAT jurisdiction.
- Pre-existing schema drift, unrelated and untouched: `prisma migrate diff`
  still reports two `appointment_vitals` constraint/index renames left by
  `20260809180000_vitals_revisions`. Deliberately left out of this migration to
  keep it scoped.

### Phase 2b — country neutrality

**Complete.** Added after a country sweep found the engine still India-shaped in
its output. 688 API tests, 57 tax-package tests, `db:rls:check` at 44 tables.

⚠️ **The bug this fixes produced correct arithmetic on a non-compliant document,
which is why nothing caught it.** `GST` was treated as meaning India, so an
Australian clinic's invoice printed a line called `IGST` for an _"inter-state
supply"_ — a concept Australian law does not contain — at exactly the right rate
and the right total. Every total-based assertion passed throughout. The lesson is
in `packages/tax/tests/countries.test.ts`, which asserts **line names and the
jurisdiction each line is owed to**, never only the total.

#### A rate and a line are not the same thing

The fix was to stop conflating them. 12% in Karnataka prints as two lines of 6%;
the same 12% in Singapore prints as one; British Columbia prints two lines at two
different rates owed to two different governments. The arithmetic is identical
and only the presentation differs — so the presentation became data on the rule,
and `priceLines()` is the only code that reads it. `tax_rules` gained:

| Column               | Why                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `line_name`          | What the authority calls it, printed verbatim. Per-**rule**, not per-country: Ontario prints one `HST`, British Columbia prints `GST` + `PST`, and both are Canada. A line called "Tax" is compliant nowhere |
| `regional_line_name` | The state half's name when splitting. NULL derives `S` + `line_name`; a union territory sets `UTGST`                                                                                                         |
| `split`              | `INTRA_STATE_HALVES` is India's constitutional split and nothing else uses it. `CGST`/`SGST`/`IGST` are derived by prefix, which is how the names are built in law                                           |
| `stacks`             | ⚠️ **The difference between Canada and everywhere else.** A regional rule normally _overrides_ the country-wide one; a stacking one _adds_ to it                                                             |

⚠️ **`rulesFor()` returns a list, and that is the whole Canada fix.** A British
Columbia clinic charges federal GST at 5% **and** provincial PST at 7%. An engine
that picks one rule bills 5% or 12% and never 5% + 7% — silently, in the
undercharging direction, with the clinic owing the difference. Both are charged
on the **net**: PST on (net + GST) would be a tax on a tax, which BC does not
levy. An HST province is the opposite shape — one harmonised line that overrides
— so Canada needs both mechanisms at once, and a test pins that they coexist.

⚠️ **A stacked rule with no base rule beneath it charges nothing** and comes back
`UNRATED`. A province that configured its PST but not the federal GST underneath
is misconfigured, and charging the PST alone is wrong in the direction nobody
notices.

#### `PROVIDER_REQUIRED`, and why it is not `NOT_REGISTERED`

US sales tax and EU cross-border consumer VAT previously reported
`NOT_REGISTERED`, which was **a false statement about a legal position** — we
hold a Californian registration; we simply cannot compute the rate. It also
pointed whoever read it at the wrong fix.

`TaxProviderQuote` is now a first-class input: the engine stays pure and
synchronous, the caller (already async, already doing I/O) fetches the quote and
passes it in, and the engine prices from the provider's own lines. Absent where
required, the result is `PROVIDER_REQUIRED` — zero charged, the reason naming
what is missing. **Plugging in Avalara or Stripe Tax is one file and no change
above the seam.**

⚠️ `UNRATED` and `PROVIDER_REQUIRED` are both **unissuable**, exported together
as `UNISSUABLE_TREATMENTS` with an `isIssuable()` helper, so Phase 5's
finalisation guard and this engine cannot drift. A seventh treatment added
without a decision about issuing is a treatment that silently becomes issuable.

#### `gst_number` → `tax_id`

The schema comment had carried a RENAME instruction since tenancy shipped, and
the screens have now generalised. ⚠️ **Hand-written as `ALTER TABLE … RENAME
COLUMN`**: `prisma migrate diff` emits `DROP COLUMN` + `ADD COLUMN` for a rename,
which succeeds, reports nothing, and leaves every clinic's tax identifier empty.
Verified by reading the value back after applying. Widened 20 → 32 for the longer
VAT and GST registration forms.

`clinic-settings.tsx` no longer hardcodes `label="GSTIN"` — the label, hint,
pattern and example all come from `locale.ts`, which has been country-aware since
tenancy. A hardcoded "GSTIN" over an Irish clinic's VAT field is not cosmetic: it
tells the user the wrong value belongs there, and the field is validated against
the country's real pattern, so they get a rejection naming a document they do not
have.

#### Measured coverage

| Clinic in                                           | Prints                                                                   | Note                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| India                                               | `CGST` + `SGST` intra-state, `IGST` across, `UTGST` in a union territory | CGST is owed to `IN`, SGST to `IN-KA`            |
| Australia / Singapore / New Zealand                 | one `GST` line                                                           | was `IGST` before this phase                     |
| Canada — BC / QC                                    | `GST` + `PST` / `GST` + `QST` stacked                                    | QST is 9.975%, hence basis points                |
| Canada — Ontario                                    | one `HST` line                                                           | regional override, not a stack                   |
| Ireland / UK / UAE / Nepal / Sri Lanka / Bangladesh | one `VAT` line                                                           |                                                  |
| Japan                                               | `Consumption Tax`                                                        | the engine never supplies the word               |
| USA                                                 | nothing, `PROVIDER_REQUIRED`                                             | prices correctly once a provider quote is passed |

Non-decimal currencies are covered: JPY (no minor unit) and KWD (three) are both
pinned, because an engine assuming two decimals overcharges a Kuwaiti patient
tenfold.

### Phase 2c — the defaults catalogue

**Complete.** 692 API tests, 63 tax-package tests, 44 protected tables.

Answers "where does a clinic say what tax applies here?" for the half rcln owns.
The tenant-facing screen is still Phase 7; this is the catalogue underneath it.

#### The design decision, and the trap it avoids

⚠️ **`tax_rule_defaults` is INHERITED at read time, never COPIED into a tenant.**
The obvious implementation — seed a clinic's `tax_rules` from the catalogue at
registration — is worth naming as a trap because somebody will propose it:

1. A rate change becomes a migration across every tenant instead of one
   effective-dated `INSERT`.
2. It **permanently** destroys the difference between _"this clinic chose 12%"_
   and _"this is a stale copy of our 2025 default"_. Both are just rows.
3. A clinic that never touches its rate card keeps an obsolete rate for ever —
   and its screen shows it as fully configured, so nobody looks.

This is the `setting_definitions` / `setting_values` shape, which solved the same
problem in this repo first. Resolution: **tenant rule → platform default →
`UNRATED`**.

⚠️ **Tenant beats platform BEFORE specificity is considered.** A clinic's
country-wide override outranks rcln's region-specific default, because the
clinic's row is an explicit act by the party who signs the return. rcln silently
overruling it would make us the author of somebody else's tax position. The cost
— a stale tenant override outliving a corrected default — is a _visibility_
problem, solved by showing divergence on the rate-card screen, not by overruling.

⚠️ **All-or-nothing per tax category, not row by row.** If a tenant holds any
applicable rule for a category, its whole set is used. Merging would look helpful
and produce rate cards nobody authored: a clinic that overrode British Columbia's
federal GST would silently keep inheriting our provincial PST, so the invoice
carries one rate it chose and one it has never seen.

#### What is seeded, and what is deliberately not

⚠️ **Only healthcare services, and only for five jurisdictions.** No medicines,
no consumables, no goods anywhere.

That is not laziness. A medicine's rate varies **by product within a country** —
India alone spans nil, 5% and 12% across formulations, and the 2025 GST
restructure moved most of them — so any single seeded figure is wrong for a large
share of what a pharmacy dispenses, and wrong _invisibly_, because an inherited
default looks configured. An unseeded category resolves to `UNRATED`: nothing
charged, the reason on the document, finalisation refusing to issue. The clinic
is forced to enter a rate it has actually checked.

⚠️ **`EXEMPT` and `ZERO_RATED` are both present and are not interchangeable.**
Australia's "GST-free" and the UAE's healthcare zero-rating genuinely zero-rate;
India, the UK and Ireland exempt medical care. An exempt supply carries no input
credit and is reported differently. Singapore, Nepal, Sri Lanka and Bangladesh
get **no rows** — their treatment is narrower or less stable, and a default
nobody verified is worse than none.

Every row carries a **required** `sourceNote` naming the statute or notification,
because a rate with no stated basis cannot be reviewed by the next person, and a
wrong row here is wrong invoices for every clinic in a country at once.

#### Why this table may be seeded when `tax_registrations` may not

The seed file directly above carries a large "DELIBERATELY NOT SEEDED" warning
about a nearly identical shape, so the distinction is recorded in both places: a
`tax_registrations` row asserts **rcln is registered somewhere** — a legal claim,
and a seeded one would collect tax against a GSTIN that does not exist. A
`tax_rule_defaults` row says only **"this country taxes this kind of thing this
way"**, names nobody, and has no effect at all on a clinic holding no
registration of its own, because the engine asks _may we charge?_ before _at what
rate?_. Seeding it charges nobody anything.

#### Removing a rule is `effectiveTo`, not `DELETE`

⚠️ There is **no DELETE route**, deliberately — `PATCH /:id/retire` takes an end
date. An invoice issued last year has to stay explicable for as long as the
retention obligation runs, and the row that priced it _is_ the explanation.
Deleting it does not un-charge the tax; it makes the charge unaccountable, and
the person who needs the answer is an auditor years later rather than the admin
clicking the button. Contrast the registrations console, which _does_ have a
DELETE: a registration entered in error asserts a fact that was never true, and
leaving it live keeps collecting tax nobody can remit.

#### Files changed

- `packages/db/prisma/schema.prisma` — `TaxRuleDefault`; `source` is a TS-only
  concept, not a column
- `packages/db/prisma/migrations/20260810120000_tax_rule_defaults/` — new; six
  CHECK constraints matching `tax_rules`, `NULLS NOT DISTINCT`, no RLS policy
- `packages/db/scripts/check-rls.ts`, `prisma/rls/enable-rls.sql` — EXEMPT with
  reasoning. ⚠️ Same argument as `tax_registrations`: every tenant reads it
  inside its own transaction, so a policy returns zero rows for everyone and no
  clinic on the platform could issue an invoice. Fail-closed here rather than
  silently-untaxed, but broken platform-wide either way
- `packages/db/prisma/seed.ts` — `seedTaxRuleDefaults`, 15 rows
- `packages/tax/src/{types,selection}.ts` — `source` on `TaxRule`, precedence in
  `rulesFor`
- `apps/api/src/services/platform/tax-rule-default.service.ts` — new
- `apps/api/src/routes/v1/platform.routes.ts` — 4 routes under
  `platform.tax.manage`
- `packages/contracts/src/billing.ts` — request/response contracts

#### Known issues

- **No platform console screen.** The API is curl-only; the screen belongs with
  the tenant rate-card screen in Phase 7 so they ship and get tested together.
- **No tenant-facing screen or permission.** A clinic still cannot add its own
  registrations or overrides — Phase 7, and the reason the seeded exemptions
  matter: a consultation-only clinic can be billed without one.
- ⚠️ **Canada is fully supported by the engine and absent from `locale.ts`**, so
  no clinic can select it at signup. Adding it there is small and separate.
- **The divergence warning does not exist**, because there is no screen to show
  it on. It is the mechanism that makes tenant-beats-platform safe.
- **The seeded rates still need a per-country review before anyone bills.** They
  are a starting point with provenance, not tax advice.

### Next phase

**Phase 3 — invoice data model.** Done; see below.

---

## Phase 3 — Invoice data model

**Complete.** 714 API tests green (was 692), 63 tax-package, 34 storage-package
and 40 billing-package tests unchanged and green, `db:rls:check` green at **48**
protected tables (was 44), repo-wide typecheck and lint green, api container
healthy.

### Completed

- **Four new tables** — `invoices`, `invoice_items`, `invoice_taxes`,
  `invoice_documents`. Org **and** branch scoped, composite-FK'd throughout,
  every tax field a snapshot.
- **`INVOICE` on `NumberSequenceType`**, and `issueInvoiceNumber()` in
  `apps/api/src/services/invoicing/invoice-number.service.ts` — the only code
  that builds an invoice-number key.
- **The 0.6 decision, implemented and measured.** The series is per branch, the
  cadence comes from the branch's country, and the period is the branch-**local**
  date resolved in Postgres.
- **Five hand-written constraints and one partial index** doing work the type
  system cannot — see below.
- **A second migration**, `20260810150500_number_sequence_prefix_width`, found
  by running the code rather than by reading it.

### Decisions worth knowing about

⚠️ **THE BRANCH CODE IS IN THE INVOICE NUMBER, AND §0.6 AS WRITTEN WAS
INCOMPLETE WITHOUT IT.** §0.6 fixed the series as per branch and the format as
`INV-{YEAR}-{SOURCE}-{SEQUENCE}`. Those two together are a compliance failure:
two branches in the same state share one GSTIN, both counters start at 1, and
both issue `INV-2026-APP-000001`. GST allows several series under one
registration and does not allow a repeated number. The format is therefore
`INV-{PERIOD_YEAR}-{SOURCE}-{BRANCH_CODE}-{000001}`. Branch codes are org-unique,
so `@@unique([organizationId, invoiceNumber])` — org-wide, stronger than the law
asks — holds. **Measured** by a test asserting both branches get `000001` and
that the two strings differ.

⚠️ **`invoices.invoice_number` IS THE ONE UNIQUE IN THIS SCHEMA THAT WANTS NULLS
DISTINCT**, which is Postgres' default, so it is written plainly — and the
convention says every nullable unique gets `NULLS NOT DISTINCT`, so the next
reader will check. Every DRAFT has a NULL number and a clinic has many drafts
open at once; `NULLS NOT DISTINCT` would let it hold exactly one. Pinned in both
directions by one test.

⚠️ **`invoices_number_matches_status` MAKES "TAKE THE NUMBER LATE" A PROPERTY OF
THE DATA.** `issueNumber()` holds a row lock until COMMIT, so it is called at
finalisation rather than at creation — which both keeps the lock window one
statement wide and stops an abandoned draft burning a serial. That was previously
a habit of one service. The CHECK refuses the two states that break a series: an
ISSUED invoice with no number (uncitable on a return) and a DRAFT that already
holds one (a permanent gap). `FINALIZING` and `CANCELLED` are deliberately
unconstrained — the first is the uncommitted middle of the transaction that sets
all three, the second is reachable from DRAFT where there is no number to
require.

⚠️ **THE CHILDREN CARRY `organization_id` AND `branch_id` THEMSELVES, AND THE
`subscription_invoice_lines` SHAPE WOULD HAVE BEEN A HOLE HERE.** That table is
isolated by a `parent_isolation` policy that asks the organization question only,
which is correct because its parent is org-scoped. An invoice is **branch**-scoped,
and a policy expression evaluates with row security _disabled_ on the table it
reads — so a parent-scoped child inherits the org half of the boundary and none
of the branch half. That is exactly the hole `appointment_status_history` had to
restate by hand. Carrying both columns makes these ordinary members of both RLS
loops instead, the call `appointment_vitals` already made. **Measured**: the test
that reads B2's invoice line as a cashier scoped to B1 is the one that fails if a
child loses its `branch_id`, and it fails for no other reason.

⚠️ **`invoice_documents.file_id` IS A PLAIN FK AND ADR-0004 DOES NOT APPLY TO
IT.** `files.organization_id` is nullable, because platform assets share the
table, so a FK from a NOT NULL column cannot reference `(organization_id, id)`.
The guarantee moves to a RESTRICTIVE `file_in_same_org` policy, written the same
way `invitation_branches.branch_in_same_org` was. This is the one place where
removing a policy re-opens a cross-tenant _reference_ rather than a cross-tenant
read: the row's own `organization_id` would be perfectly correct and
`tenant_isolation` would pass. It is also **stricter** than `files`' own policy,
which permits NULL for platform assets — an invoice document is never one.
Both directions pinned.

⚠️ **THERE IS NO GENERIC `source_id`. EACH INTEGRATED SOURCE GETS ITS OWN COLUMN
AND ITS OWN COMPOSITE FOREIGN KEY.** The first draft of this phase carried a
polymorphic `source_id` with no FK, on the reasoning that four of the seven
source tables do not exist. That was the wrong trade and it was reversed before
anything was committed. The risk a FK closes here is **not** "this invoice bills
an appointment that does not exist" — ids are random uuids and nobody stumbles
onto one. It is "this invoice bills **another clinic's** appointment", and only
the composite `(organization_id, appointment_id)` reference answers that. A
loose uuid leaves the guarantee as "the service remembers to re-read it", which
is precisely the class of promise ADR-0004 exists to replace.

⚠️ **STUB TABLES FOR THE MISSING MODULES WERE CONSIDERED AND REJECTED**, and the
reason is worth recording because it is the obvious-looking fix. A table holding
only an `id` proves a row EXISTS and says nothing about who owns it — the wrong
half of the problem, and the FK to it would be security theatre. Giving the stub
an `organization_id` and a `(organization_id, id)` unique makes it a
half-designed `lab_orders`, authored with no lab module behind it, plus an RLS
policy and an isolation test guarding a table that can never hold a row. And it
saves nothing: the real module ships a migration that creates its table anyway,
and adding `invoices.lab_order_id` in that same migration is free. The stub only
moves the design decision forward to the moment you know least.

The cost accepted instead: `invoices` grows one nullable column per billable
source. At five or six that is fine; at twenty it would want a different design,
and by then there would be twenty real modules to design against.
`invoices_source_reference_matches_type` keeps the enum and the columns honest
and gains one clause per module. **Measured**: the cross-tenant case is pinned by
a test that inserts an org-A invoice citing an org-B appointment and expects the
FK, not a policy, to refuse it.

⚠️ **`invoice_taxes` HANGS OFF THE ITEM, NOT THE INVOICE, AND CITES WHICH TABLE
PRICED IT.** A bill carries an EXEMPT consultation beside a STANDARD-rated
medicine; a per-invoice tax line cannot express that. Each row is one **printed**
line — 12% in Karnataka is two rows of 6% owed to two governments, the same 12%
in Singapore is one — so `@rcln/tax` decides the presentation and this table
records what it decided. `tax_rule_id` and `tax_rule_default_id` are two nullable
columns with a CHECK that at most one is set, rather than one id and a source
enum: the difference between a rate the clinic authored and one it inherited from
rcln's catalogue is the question the rate-card screen and an auditor both ask, and
the two rules live in two tables so one id cannot reference both. Both NULL is
legitimate — an UNRATED line involved no rule at all.

⚠️ **THE DISCOUNT INPUT IS THREE COLUMNS AND A CHECK, NOT ONE OVERLOADED
COLUMN.** "10% off" and "₹150 off" are different instructions that can produce
the same amount, and the invoice prints which was given. A single
`discount_value` whose meaning depends on `discount_type` is a column that reads
differently depending on another column — and a partial `update()` that changes
one and not the other is the ordinary way to get there. Percentages are basis
points, bounded at 10000: a discount larger than the line is a negative charge,
which is a credit note and goes through a different door.

⚠️ **THE PERIOD IS THE BRANCH-LOCAL DATE, RESOLVED IN POSTGRES.** 00:30 IST on 1
April is 19:00 UTC on 31 **March**: read as an instant it belongs to the old
financial year, read in the clinic's zone it starts the new one. The container's
zone is UTC and the browser's is the user's; neither is the clinic's. Both sides
of that midnight are pinned by tests, and they are the two cases that would
silently file a row in the wrong return.

⚠️ **`number_sequences.prefix` WAS VARCHAR(16), AND THE FIRST INVOICE THIS
REPOSITORY EVER NUMBERED FAILED ON IT.** `INV-2026-APP-MAIN-` is 18 characters
and `branches.code` may be 32 on its own; the old width was sized for `P` and
`MRN-`. It surfaced as a raw Postgres `22001` out of `issueNumber`'s
`$queryRaw` — at the moment a cashier finalises a bill, with no type, no lint and
no schema check able to see it. Widened to 64. **This is the phase's argument for
running the code.**

⚠️ **THE MIGRATION WAS REBUILT FROM EMPTY, NOT PATCHED.** The source-reference
reversal and the prefix widening both landed after the first version had been
applied to the development database. Because nothing was committed and the tables
held no real rows, the right move was to drop the objects, delete the migration
records and regenerate one migration — rather than ship Phase 3 as a migration
plus two corrections to itself. That is the ONLY circumstance in which an applied
migration may be rewritten here: uncommitted, unshared, and no data. Anything
past a push is a new migration, always.

⚠️ `ALTER TYPE "NumberSequenceType" ADD VALUE` is written `IF NOT EXISTS`, because
Postgres has no `DROP VALUE` — the rollback above could not remove it, so the
statement has to be safe against an enum that already carries it. **Verified
against a genuinely empty database**: all 36 migrations were applied to a fresh
`rcln_freshcheck`, and the partial index, the three CHECKs and the enum value
were read back from it. Adding an enum value inside a transaction is legal from
Postgres 12 as long as nothing USES the value in the same transaction, and
nothing here does — but that is exactly the kind of claim that is worth checking
rather than reasoning about.

⚠️ **NOTHING ENFORCES IMMUTABILITY YET.** The status column is a convention until
Phase 5's database-level guard lands. Said plainly in the model comment so the
gap is not mistaken for a guarantee.

### Files changed

- `packages/db/prisma/schema.prisma` — `InvoiceSourceType`, `InvoiceStatus`,
  `InvoiceDiscountType`; `Invoice`, `InvoiceItem`, `InvoiceTax`,
  `InvoiceDocument`; `INVOICE` on `NumberSequenceType`; `prefix` widened;
  back-relations on `Organization`, `Branch`, `Patient`, `Appointment`, `User`,
  `StoredFile`, `IssuerTaxRegistration`, `TaxRule`, `TaxRuleDefault`
- `packages/db/prisma/migrations/20260810150000_patient_invoices/` — new, and
  the only migration this phase adds
- `packages/db/prisma/rls/enable-rls.sql` — all four tables into `org_scoped`
  **and** `branch_scoped`, plus the `file_in_same_org` restrictive policy
- `apps/api/src/services/invoicing/invoice-number.service.ts` — new
- `apps/api/src/services/numbering/number-sequence.service.ts` — `INVOICE` on
  the `SequenceType` union
- `apps/api/tests/integration/invoice-numbering.test.ts` — new, 8 cases
- `apps/api/tests/integration/tenant-isolation.test.ts` — 12 new cases
- `.kb/modules.json` — the `Invoicing` module entry
- `.kb/Database/schema-design.md` — §11's invoice tables redrawn as built, with
  the four deliberate departures from the original sketch stated

### Database changes

Four new tenant tables, each with **both** `tenant_isolation` and a RESTRICTIVE
`branch_isolation` policy, `@@unique([organizationId, id])` composite-FK targets,
and hand-appended SQL:

| Object                                   | Why Prisma could not emit it                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `invoices_number_matches_status`         | ties the number and issue date to the status                                                        |
| `invoices_source_reference_matches_type` | ties the source type to its reference column; gains a clause per module                             |
| `invoices_discount_input_matches_type`   | and the same on `invoice_items` — the type and its input must agree, percentages bounded at 100%    |
| `invoice_items_line_number_positive`     | a zero line sorts ahead of every real one                                                           |
| `invoice_taxes_one_rule_source`          | a tax line resolves from one rule table, never both                                                 |
| `invoice_taxes_rate_bps_non_negative`    |                                                                                                     |
| `invoice_documents_current_per_type_key` | PARTIAL unique, `WHERE superseded_at IS NULL` — a plain one refuses the retry after a failed render |
| `file_in_same_org`                       | the RESTRICTIVE policy replacing an impossible composite FK                                         |

`number_sequences.prefix` widened 16 → 64 in a second migration.

`db:rls:check` goes from 44 to 48 protected tables.

### API changes

None. Phase 3 is the data model; no route was added or altered. The first routes
are Phase 7.

### Tests added

- `apps/api/tests/integration/invoice-numbering.test.ts` — 8 cases against real
  Postgres: the number's shape, two branches whose series cannot collide, a
  series per source, the Indian financial year holding across 1 January and
  resetting in April, Ireland on the calendar year, both sides of midnight IST,
  and a branch the tenant cannot see.
- `apps/api/tests/integration/tenant-isolation.test.ts` — 14 cases: fail-closed,
  cross-tenant reads of all four tables, the **branch** boundary inside one
  tenant (the case a parent-scoped child would fail), the WITH CHECK write, both
  directions of `file_in_same_org`, an invoice billing another clinic's
  appointment refused by the FK itself, many numberless drafts beside a rejected
  duplicate number, and every hand-written constraint.

### Known issues

- ⚠️ **Immutability is not enforced.** An `ISSUED` invoice's totals can still be
  rewritten by any `update()`. Phase 5.
- **Only `APPOINTMENT` has a reference column**, because it is the only source
  whose table exists. `PROCEDURE` and `SERVICE` carry no reference at all until a
  service catalogue exists, and an invoice of those types is currently
  indistinguishable from a manual one except by its number.
- **Nothing computes a money column.** Every total is written by its caller and
  Phase 4's engine does not exist, so an invoice inserted today can be internally
  inconsistent. The columns default to 0, which is honest for a fresh draft and
  wrong for anything else.
- **No routes, contracts, permission wiring or screen.** The `billing.invoice.*`
  codes have existed since the platform seeded them and still gate nothing.
- **No payments table for patient invoices.** `amount_paid` is a column with
  nothing to move it; a payments/allocations pair is a later phase, and until it
  exists `PARTIALLY_PAID` and `PAID` are unreachable states.
- **`invoice_items` has no `deleted_at`, deliberately** — a line is hard-deleted
  while DRAFT. If a clinic ever needs the history of an edited draft, that is an
  audit question, not a soft-delete one.
- **Tax behaviour is EXCLUSIVE only.** There is no `tax_behavior` column: adding
  one before Phase 4 honours inclusive pricing would be a column that silently
  produces the wrong price. It matters for consumer-facing EU/UK prices.
- Pre-existing schema drift, unrelated and untouched: `prisma migrate diff` still
  reports the two `appointment_vitals` constraint/index renames left by
  `20260809180000_vitals_revisions`. Left out of both migrations to keep them
  scoped, as Phases 1 and 2 did.

### Next phase

**Phase 4 — calculation engine.** Done; see below.

---

## Phase 4 — Calculation engine

**Complete.** 723 API tests green (was 714), **35 invoicing-package** tests new,
63 tax-package, 34 storage-package and 40 billing-package tests unchanged and
green, `db:rls:check` green at 48 protected tables, repo-wide typecheck and lint
green.

### Completed

- **`@rcln/invoicing`** — a new workspace package holding the whole calculation
  seam. Depends on `@rcln/payments` and `@rcln/tax` and nothing else: no Prisma,
  no Express, no clock at all. It is now the **only** code allowed to decide what
  goes in a money column on `invoices` or `invoice_items`.
- **The §0.5 order, implemented once** — gross, line discount, apportioned
  invoice discount, per-line tax, cash rounding, each step rounded at the
  currency's own scale before the next reads it.
- **`apportion()`** — largest-remainder split of the invoice-level discount,
  pro-rata by taxable amount, exact by construction.
- **Quantity as integer thousandths**, matching `Decimal(14,3)`, with a parse
  that refuses a fourth decimal place rather than truncating it.
- **`priceDraftInvoice()`** in `apps/api/src/services/invoicing/` — the seam.
  One tax-context read per invoice, then pure arithmetic. It is the first caller
  `taxForItem` has ever had.
- **`TaxLine` now cites the rule that priced it**, which is what makes
  `invoice_taxes`' two audit columns fillable at all.

### Decisions worth knowing about

⚠️ **THE ENGINE IS IN A NEW `packages/invoicing/`, AND §0.8 SAYING
`packages/billing` WAS THIS DOCUMENT CONTRADICTING ITSELF.** §0.1 fixed the
naming for every phase — the new engine is _invoicing_, the existing one stays
_billing_, "where a screen or a permission could mean either, it says which" —
and then §0.8 put the new engine inside the old one's package. `@rcln/billing`'s
own header says it is "what a subscription is, and what happens to it". Phase 2
had already split `@rcln/tax` out of it for exactly this reason and recorded why:
two issuers asking the same question need one copy of the rules and separate
inputs. The same argument decides this, so the deviation is a correction rather
than a preference.

⚠️ **THE INVOICE-LEVEL DISCOUNT IS APPORTIONED BEFORE TAX, AND THE TEST FOR IT
ASSERTS THE TAX RATHER THAN THE TOTAL.** This is §0.5's deliberate deviation from
the brief made real, and the reason it needs a test that names the wrong answer:
the brief's order produces ₹1080 where this produces ₹1062, and **both totals are
arguable**. What is not arguable is the ₹180 of GST inside the first one — tax
remitted to a state government on ₹100 the patient never paid, which the clinic
cannot recover. A test asserting only the total would pass under either.
**Measured**: implementing the brief's order instead fails 6 cases.

⚠️ **THE APPORTIONMENT IS WEIGHTED BY WHAT IS _LEFT_ OF A LINE, NOT BY ITS
GROSS.** A line already discounted to zero must absorb none of the whole-bill
discount; weighting by gross gives it a share of a second discount out of all
proportion to what remains of it and drives `taxable_amount` negative — a charge
the invoice would then have to explain. **Measured**: weighting by gross fails
exactly the case written for it.

⚠️ **LARGEST-REMAINDER IS NOT TIDINESS, AND THE TIE-BREAK IS PART OF IT.** ₹100
across three equal lines is 33.33 three times, which is ₹99.99 — a paisa the
invoice is short, found by reconciliation and explicable by nobody. Ties break on
the **lower index**, so the same invoice priced twice produces the same document;
a tie-break that depended on iteration order would make a reprint differ from the
original, which is the one thing a printed invoice may never do. **Measured**:
dropping the remainder distribution fails 4 cases.

⚠️ **A DISCOUNT LARGER THAN WHAT IT REDUCES IS REFUSED, NOT CLAMPED.** Clamping
"₹500 off" on a ₹300 line to ₹300 prints a bill the cashier did not intend and
tells nobody. The amount they typed is simply wrong and they are the only one who
can say what was meant — and a charge that goes negative is a credit note, a
different document through a different door (Phase 5).

⚠️ **TAX IS SUMMED FROM THE PRINTED LINES, NEVER FROM THE QUOTE'S OWN TOTAL —
AND THIS CLAIM WAS UNTESTED UNTIL IT WAS MEASURED.** Every quote `@rcln/tax`
produces has a total equal to the sum of its lines, so substituting `quote.total`
left the whole suite green. The case that distinguishes them is an **external
provider's** quote, where the two genuinely can disagree, and there the printed
lines must win: they are what a patient adds up on the page and what a return is
filed from. A test was added for exactly that, and only then did the substitution
fail. The lesson is Phase 2b's, again: a green suite is evidence about the tests.

⚠️ **CASH ROUNDING IS APPLIED TO THE TOTAL AND NEVER TO A LINE.** Rounding a line
changes the taxable value of a supply _after_ the tax on it was computed, so the
document states a tax that is not the rate times the base — the first internal
contradiction an auditor checks for. It keeps its own column for the same reason:
`grand_total` should never need explaining.

⚠️ **QUANTITY IS AN INTEGER COUNT OF THOUSANDTHS, FOR THE SAME REASON `Money`
IS.** `invoice_items.quantity` is `Decimal(14,3)` because half a tablet is real.
A float holds 0.5 exactly and 0.001 not at all, and `unitPrice × 1.15` on a float
is how a line comes out a paisa short of the sum of its parts. `scaleMoney`
multiplies before it divides, so `price × milli / 1000` never leaves integer
arithmetic. A fourth decimal place **throws** rather than truncating — a silently
dropped digit is a discrepancy between what the pharmacy counted and what the
patient was charged, noticed by neither.

⚠️ **`quoteTax` IS A CALLBACK, NOT A TAX CONTEXT, SO THE PLACE OF SUPPLY STAYS
DEFINED IN ONE PLACE.** `taxForItem` is the only code that knows a patient
invoice is supplied at the **branch** and not at the patient's address. Taking
registrations and rules into `@rcln/invoicing` directly would make it a second
place that could get that backwards — the Karnataka-consultation-for-a-Kerala-
patient failure Phase 2 exists to prevent. The engine stays pure either way: the
caller has already done its one read by the time the callback is invoked.

⚠️ **ONE UNRATED LINE MAKES THE WHOLE DOCUMENT UNISSUABLE, AND THE ENGINE ASKS
`isIssuable()` RATHER THAN RESTATING THE LIST.** `TREATMENT_PRECEDENCE` therefore
contains only the _issuable_ treatments — a seventh treatment added to
`@rcln/tax` without a decision about issuing cannot become issuable here by being
missing from a list. A mixed bill summarises as `STANDARD`, because the summary
is what the document **did** and it charged tax.

⚠️ **`TaxLine` GAINED `ruleId` / `ruleSource`, AND WITHOUT THEM PHASE 3'S AUDIT
COLUMNS COULD ONLY EVER BE NULL.** `invoice_taxes.tax_rule_id` and
`.tax_rule_default_id` exist to record whether a rate was one the clinic authored
or one it inherited from rcln's catalogue — the question the rate-card screen and
an auditor both ask. Nothing carried the id out of `@rcln/tax`. Both halves of an
Indian split cite the **same** rule: one rate split by statute is still one rule.
Both columns NULL stays legitimate and means _no rule was involved_ — the
`UNRATED` and provider-quote cases.

⚠️ **THE REGISTRATION ID IS RESOLVED BY RE-ASKING `registrationFor()`, NOT BY
THREADING IT THROUGH THE QUOTE.** `TaxQuote` carries the registration **number**
because that is what the invoice prints, and the number is snapshotted beside the
id precisely because the row can be corrected while an issued document's string
may not change. Re-running the same selection rule is one definition asked twice;
adding the id to the quote would be a second opinion about which registration
applied. `issuer_tax_registration_id` is left NULL on a `NOT_REGISTERED` document
— citing a registration it did not charge under is a claim about which return the
invoice belongs on.

⚠️ **`priceDraftInvoice()` PERSISTS NOTHING, AND THAT IS THE PHASE BOUNDARY.** An
invoice becomes a document at finalisation: taking the number, freezing the
financials, refusing an `UNRATED` line. Writing rows here would put half of that
decision in the wrong file. What it returns is exactly the set of column values
Phase 5's writes will use.

### Files changed

- `packages/invoicing/**` — new package: `errors`, `quantity`, `types`,
  `discount`, `pricing`, `index`, plus 1 test file and the four config files
- `packages/tax/src/types.ts` — `id` on `TaxRule` and `IssuerRegistration`,
  `legalName` on the latter, `ruleId` / `ruleSource` on `TaxLine`
- `packages/tax/src/engine.ts` — `priceLines` cites the rule on every line it
  emits, including both halves of a split
- `apps/api/src/services/invoicing/pricing.service.ts` — new, the seam
- `apps/api/src/services/invoicing/tax.service.ts` — carries the row ids and the
  legal name across
- `apps/api/package.json` — `@rcln/invoicing` dependency
- `apps/api/tests/integration/invoice-pricing.test.ts` — new, 9 cases
- `.kb/modules.json` — the `Invoicing` module entry updated

### Database changes

**None.** Phase 4 is arithmetic; Phase 3 already created every column it fills.
No migration, no RLS change, `db:rls:check` unchanged at 48 tables.

### API changes

None. The first routes are Phase 7.

### Tests added

- `packages/invoicing/tests/pricing.test.ts` — 35 cases, no tenant and no clock:
  the calculation order, both discount shapes and both refusals, apportionment
  exactness across arbitrary weights, the India split's odd paisa, the rule-id
  columns, mixed and unissuable documents, cash rounding in both directions, and
  JPY and KWD.
- `apps/api/tests/integration/invoice-pricing.test.ts` — 9 cases against real
  Postgres: a consultation and a medicine billed under one registration at two
  rates, the CGST/SGST split from real rows, the clinic's own rule id versus an
  inherited default, the registration and legal name recorded, a whole-bill
  discount against a real rate card, cross-tenant rate leakage asserted as 5%
  versus 18%, a branch the tenant cannot see, and an unconfigured category
  marking the bill unissuable.

⚠️ **Four deliberate breakages were applied and reverted to prove the suite
bites**, since this phase's failures are all "arithmetic that looks right":

| Breakage                                                       | Cases failed                                             |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| Subtract the invoice discount after tax (the brief's §7 order) | 6                                                        |
| Drop largest-remainder, keep the floors                        | 4                                                        |
| Weight apportionment by gross instead of post-line-discount    | 1                                                        |
| Take `quote.total` instead of summing the printed lines        | 0 → **1** after the provider-disagreement case was added |

### Known issues

- ⚠️ **Nothing persists a priced invoice.** `priceDraftInvoice` computes and
  returns; no `invoices` row has ever been written from a computed total. Phase 5
  finalises, Phase 7 exposes it. Same shape as `DocumentService` at the end of
  Phase 1 and `taxForItem` at the end of Phase 2 — except that this phase closes
  the second of those.
- ⚠️ **`UNRATED` is still only reported.** The engine now says `issuable: false`
  and lists why, and nothing yet refuses to issue. Phase 5.
- **Tax behaviour is EXCLUSIVE only.** `netOf()` in `@rcln/tax` still has no
  caller and there is no `tax_behavior` column. Adding one before the engine
  honours inclusive pricing would be a column that silently produces the wrong
  price. It matters for consumer-facing EU/UK prices.
- **Cash rounding is a parameter, not a setting.** `cashRoundingMinor` is passed
  in and nothing resolves it from `resolveSettings()`. It belongs with the
  billing settings screen in Phase 7; until then every caller passes 1.
- **No multi-currency invoice, deliberately.** One currency per document, and a
  line in another throws. A clinic billing in two currencies on one invoice needs
  an exchange-rate snapshot per line, which is a different design.
- **The `numeric(14,2)` conversion has no home yet.** The engine speaks minor
  units and the columns are `Decimal`; §0.4 says the conversion happens at the
  persistence boundary in one place, and that place is Phase 5's writer. Nothing
  converts today, so nothing can convert inconsistently — but it is the next
  thing that could.
- Pre-existing schema drift, unrelated and untouched: `prisma migrate diff` still
  reports the two `appointment_vitals` constraint/index renames left by
  `20260809180000_vitals_revisions`.

### Next phase

**Phase 5 — lifecycle and immutability.** DRAFT → FINALIZING → ISSUED →
PAID/CANCELLED/VOID, with the issued financials immutable at the **database**,
not only in the service. It is the first caller of `issueInvoiceNumber()`, the
first writer of a computed money column, and the place `isIssuable()` finally
refuses something: an invoice carrying an `UNRATED` or `PROVIDER_REQUIRED` line
must not reach ISSUED. It also owes the `region_code` check Phase 2 deferred — a
multi-state group's second branch still carries the wrong one and nothing
prompts anybody.

**Phase 5 — lifecycle and immutability.** Done; see below.

---

## Phase 5 — Lifecycle and immutability

**Complete.** 744 API tests green (was 723), **21 of them new**; 35
invoicing-package, 63 tax-package, 34 storage-package and 40 billing-package
tests unchanged and green; `db:rls:check` green at 48 protected tables; repo-wide
typecheck and lint green (30 turbo tasks); api container healthy.

### Completed

- **Three triggers**, in `20260811090000_invoice_lifecycle_immutability`:
  `invoices_lifecycle_guard` (the transition table plus a frozen-column
  allow-list), `invoices_no_delete_after_issue`, and
  `invoice_children_follow_parent` on `invoice_items` and `invoice_taxes`. Owner
  exempt, the same shape `audit_logs` and `appointment_status_history` use.
- **`invoice-lifecycle.service.ts`** — `createDraftInvoice`,
  `repriceDraftInvoice`, `finalizeInvoice`, `cancelDraftInvoice`, `voidInvoice`.
  The first writer of a computed money column and the first caller
  `issueInvoiceNumber()` has ever had.
- **`money.ts`** — the one `numeric(14,2)` ↔ minor-units boundary for patient
  invoices. §0.4's "conversion at the persistence boundary only, in one place"
  finally has its place.
- **The `region_code` check Phase 2 deferred**, and it is not the check that was
  expected — see below.
- **`isIssuable()` finally refuses something.** An `UNRATED` or
  `PROVIDER_REQUIRED` line cannot reach ISSUED, three phases after the treatment
  was invented.

### Decisions worth knowing about

⚠️ **THE FROZEN SET IS AN ALLOW-LIST OF WHAT MAY STILL MOVE, NOT A DENY-LIST OF
WHAT MAY NOT.** A deny-list is a list that the next migration adds a column
beside, and that column is then silently mutable on an issued document with
nothing in the migration mentioning it. Stated the other way round, a column
added tomorrow is frozen by default and somebody has to come and argue for it.
This is `roles.ts`'s lesson applied to a different table: "everything except" is
a definition that grows in the wrong direction. The comparison is done as
`jsonb`, so the function does not need editing when the model does. What stays
mutable is `status`, `amount_paid`, the four cancel/void columns and
`updated_at` — and `deleted_at` is deliberately absent, because soft delete is
for a DRAFT and an issued invoice is VOIDed.

⚠️ **THE CHILDREN NEEDED THEIR OWN GUARD, AND WITHOUT IT THE FIRST ONE PROTECTS A
NUMBER RATHER THAN A DOCUMENT.** An invoice whose `grand_total` cannot move but
whose lines can is an invoice that states a total which is not the sum of what it
prints — the first internal contradiction an auditor checks for, and the one the
patient's copy and the clinic's copy would then disagree about. **Measured**:
dropping the two child triggers fails exactly 2 cases and leaves the other 19
green, which is what a suite that only tested the header would have looked like.

⚠️ **AN INVISIBLE PARENT IS ALLOWED THROUGH THE CHILD GUARD, AND THAT IS NOT A
HOLE.** Two cases reach it: a cascade from the parent's own DELETE, where the
parent row is gone by the time the child trigger fires and
`invoices_no_delete_after_issue` has already ruled on whether that DELETE was
permitted at all; and a write citing an invoice this tenant or branch cannot see,
which RLS' own `WITH CHECK` refuses a moment later on the child row itself. In
neither case is there a document to protect. Returning _false_ instead would
break `ON DELETE CASCADE` from `organizations`, which is the failure the
`appointment_status_history` migration records at length.

⚠️ **`FINALIZING` IS THE SHAPE OF THE WRITE, NOT A ROW ANYBODY WILL EVER FIND.**
Finalisation is two updates inside one transaction: DRAFT → FINALIZING takes the
number, the issue date and every frozen total while the row is still open, and
FINALIZING → ISSUED changes nothing but the status. The guard reads `OLD.status`,
so splitting them is what lets the financial columns be written by the same
statement that leaves DRAFT and be immutable the instant the row is ISSUED.
Because both statements are in one transaction, no other session can observe the
state — the enum comment's "a row observed in this state after a crash" describes
something this implementation cannot produce, and that is worth saying plainly
rather than leaving as an implied promise.

⚠️ **THE `region_code` CHECK CANNOT BE A NULL CHECK, AND THE OBVIOUS VERSION OF
IT PASSES EVERY BILL IT WAS WRITTEN TO REFUSE.** `registrationFor()` ends
`?? inCountry[0]`. That fallback is right for pricing — a clinic with one GSTIN
should not have every line come back untaxed because one branch row is imperfect
— and it means a wrong `region_code` **never surfaces as a missing
registration**. It surfaces as a perfectly plausible invoice issued under another
state's GSTIN, with the right tax on it, in the wrong return. So the check
mirrors the selection rule and asks whether the fallback was taken: a
registration matching the branch's region exactly, or a country-wide one, must
exist. **Measured**: implementing it as "refuse when no registration resolves"
fails 0 cases and refuses nothing at all; the real check fails exactly the one
case written for it.

⚠️ **HOLDING NO REGISTRATION AT ALL IS LEGITIMATE AND MUST PASS.** A clinic below
the registration threshold has a legal position and `NOT_REGISTERED` is it.
Conflating that with the case above would stop every unregistered clinic on the
platform from billing anybody — and it is a one-character difference in the
predicate. Both directions are pinned.

⚠️ **A DRAFT IS PRICED THE MOMENT IT EXISTS, AND PHASE 3 SHIPPED WITH THE
OPPOSITE.** Every money column defaults to 0, which is honest for an empty
invoice and wrong for one with lines on it — a draft carrying five lines and a
`grand_total` of zero is what the cashier reads off the screen. Phase 3 listed
this as "an invoice inserted today can be internally inconsistent". There is now
no state in which an invoice's totals are not the totals of its lines.

⚠️ **FINALISATION RE-PRICES FROM THE STORED INPUTS AND NEVER TRUSTS THE STORED
TOTALS.** `invoice_items`' input columns — description, category, quantity, unit
price, the two discounts — are what the cashier typed; everything else on the row
is derived. A rate corrected between the draft being opened and the patient being
handed the bill must reach the document, and re-deriving is the only way it does.
The lines are deleted and re-inserted rather than diffed: a reprice can change how
many there are and which position each holds, and a diff that got it wrong would
leave a stale row satisfying every constraint. Item ids therefore change on every
reprice, which is safe precisely because nothing may reference a draft's line.

⚠️ **TAKING THE NUMBER LAST BUYS THE LOCK WINDOW AND _NOT_ THE SERIAL, AND THE
COMMENT SAYING OTHERWISE WAS WRITTEN BEFORE IT WAS MEASURED.** `issueNumber()`
holds a row lock on the branch's counter until COMMIT, and that lock is what every
other till at the branch queues behind — so pricing, the issuable check and the
registration read all belong in front of it. But the claim that this is also what
stops a refused bill burning a serial is **false**: moving the number ahead of the
issuable check fails **0** tests, because the throw rolls the whole transaction
back and takes the counter's increment with it. The serial is safe because
finalisation is one transaction. Phase 2b's lesson again, in the other direction:
a correct implementation can still rest on a wrong reason.

⚠️ **`invoice_taxes` IS WRITTEN BY `createMany` AND NOT AS A NESTED CREATE UNDER
THE ITEM.** It reaches its parents through composite foreign keys (ADR-0004), and
Prisma's nested writes supply the parent key themselves — leaving no way to also
state `organization_id` and `branch_id`, which this table carries in its own right
so that it is an ordinary member of both RLS loops rather than inheriting the org
half of the boundary and none of the branch half. This is the Phase 3 decision
about `subscription_invoice_lines` showing up as an API constraint rather than as
a schema one.

⚠️ **CREDIT NOTES ARE DEFERRED, DELIBERATELY, AND §0.8 LISTED THEM HERE.** There
is no table, no number series and no `CREDIT_NOTE` source type; adding all three
is a Phase-3-sized data-model change inside a phase whose job is lifecycle.
Phase 4's own "Next phase" paragraph — written last and most specifically — does
not mention them. They are also unreachable in the sense that matters: with no
patient-payments table `amount_paid` is always zero, so no void can yet involve
money, and with no PDF (Phase 6) and no route (Phase 7) nothing could consume the
document. Designing it now with nothing to design against is the mistake §0.3
records about the lab and pharmacy stubs. `cancellation_reason` is what a clinic
has until then, and `voidInvoice` requires one.

### Files changed

- `packages/db/prisma/migrations/20260811090000_invoice_lifecycle_immutability/`
  — new, and the only migration this phase adds
- `packages/db/prisma/schema.prisma` — comments only: the invoice block's "until
  Phase 5 lands" gap replaced by what actually landed, and the transition diagram
  onto `InvoiceStatus`
- `apps/api/src/services/invoicing/invoice-lifecycle.service.ts` — new
- `apps/api/src/services/invoicing/money.ts` — new
- `apps/api/tests/integration/invoice-lifecycle.test.ts` — new, 21 cases
- `.kb/modules.json` — the `Invoicing` module entry

### Database changes

No new table, no new column, no RLS change — `db:rls:check` unchanged at 48.
Three trigger functions and five triggers, none of which `prisma migrate diff`
can see:

| Object                           | What it refuses                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `invoices_lifecycle_guard`       | an illegal transition, and any edit to the document's own columns once it has left DRAFT |
| `invoices_no_delete_after_issue` | a numbered invoice DELETEd out of its series                                             |
| `invoice_is_open`                | (helper) — the parent's state, `true` when the parent is invisible                       |
| `invoice_children_follow_parent` | a line or tax row inserted, edited or removed under an issued invoice                    |

### API changes

None. Phase 5 is the service layer; the first routes are Phase 7, and
`billing.invoice.*` still gates nothing.

### Tests added

`apps/api/tests/integration/invoice-lifecycle.test.ts` — 21 cases against real
Postgres, of which 8 assert a refusal **through the `rcln_app` role rather than
through the service**, because the whole argument for putting the lifecycle in
Postgres is that the service is one of several paths a write can take. A suite
that only called the service would pass just as happily with no trigger at all.

Covered: a draft priced on creation, its tax rows split into CGST and SGST, a
reprice picking up a rate change; finalisation writing the number, the issuer and
the treatment; the unrated refusal, the region refusal and its correction, the
unregistered clinic that may still issue, a second finalisation refused, and an
abandoned draft leaving no hole in the series; the total, the number, the customer
snapshot, `deleted_at`, the un-issue, the DELETE, a line and a tax row all refused
on an issued invoice; settlement and both reversals still moving; and cancel/void
refusing each other's states.

⚠️ **Four deliberate breakages were applied and reverted:**

| Breakage                                                                                    | Cases failed                                                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The region check written as "refuse when no registration resolves"                          | **0** — it refuses nothing, which is the point                       |
| Take the invoice number before the issuable check                                           | **0** — the transaction already covers it; the comment was corrected |
| Drop `invoice_items_follow_parent` and `invoice_taxes_follow_parent`                        | 2                                                                    |
| Put `grand_total` and `deleted_at` on the mutable allow-list, and drop the transition table | 5                                                                    |

The first two are the valuable ones. Both were beliefs held _before_ they were
measured, and both were wrong in the same direction — a check or an ordering that
looked load-bearing and was not.

### Known issues

- **No credit note.** See the decision above. `voidInvoice` records a reason and
  raises no document.
- **PARTIALLY_PAID and PAID are reachable transitions with nothing to drive
  them.** There is no patient payments/allocations pair, so `amount_paid` only
  ever moves by hand. The transitions and the allow-list are tested directly
  because nothing else exercises them.
- **Cash rounding and the invoice currency are parameters, not settings.**
  `resolveSettings()` has no billing keys; the currency falls back to the
  organization's. Phase 7's settings screen.
- **Nothing asks "is this visit already billed?"** The `invoices` model comment
  points at this phase for it, but the answer is a query about the LIVE invoice
  for an appointment and its only consumer is Phase 8's day board. Left there.
- **No audit rows.** Finalising, cancelling and voiding are exactly the
  accountable acts `audit_logs` exists for, and none of them writes one — Phase
  10, with the allow-list snapshot discipline.
- **A `FINALIZING` row is unobservable**, so the enum's "found after a crash"
  case cannot arise from this implementation. It would if finalisation were ever
  split across transactions; nothing should split it.
- **`repriceDraftInvoice` is O(lines) round trips**, one `create` plus one
  `createMany` per line. Fine at a clinic's invoice sizes, and the composite-FK
  constraint above is why it is not one `createMany`.
- Pre-existing schema drift, unrelated and untouched: `prisma migrate diff` still
  reports the two `appointment_vitals` constraint/index renames left by
  `20260809180000_vitals_revisions`.

### Next phase

**Phase 6 — PDF generation.** Data → template → renderer, three layers, generated
once at issue and stored via `DocumentService`, never regenerated on download. It
is the first writer of `invoice_documents` and the first caller `DocumentService`
has had since Phase 1. The immutability guard deliberately does **not** cover
`invoice_documents` — a FAILED render is retried by superseding the row, and
`invoice_documents_current_per_type_key` is the partial unique that allows it.

**Phase 6 — PDF generation.** Done; see below.

---

## Phase 6 — Document rendering

**Complete.** **757 API tests** green (was 744) — 447 in the first split, 310 in
the second; **21 documents-package** and **10 queue-package** tests new; 63 tax,
35 invoicing, 40 billing and 34 storage tests unchanged and green;
`db:rls:check` unchanged at **48** protected tables; repo-wide typecheck and lint
green (**36 turbo tasks**, up from 30 — two new packages); api and worker
containers healthy.

**Verified end to end, not reasoned about:** a draft created and issued through
`issueInvoice()` → a job on `QUEUE.DOCUMENTS` → the worker's Chromium → bytes on
the host at `$STORAGE_LOCAL_PATH` → an `invoice_documents` row recording template
`invoice` v1, `READY`, with the stored checksum matching the file on disk
byte-for-byte.

### The requirement that shaped everything

The brief for this phase was not "make a PDF". It was: **the invoice on screen
and the invoice a patient downloads must be the same document**, and the clinic
must be able to see it before it is issued.

That rules out the obvious implementation — a PDF library drawing boxes, plus a
React screen laying out the same figures — because those are two templates that
have to be kept looking alike by hand, and they diverge on the first edit that
touches only one of them. There is no test for "these two still look the same".

So the guarantee is structural instead:

```
InvoiceDocumentData  ──▶  renderInvoiceHtml(data)  ──▶  one HTML string
   (a pure snapshot)       (React → static markup)        │
                                                          ├─▶ web:    <iframe srcdoc>
                                                          └─▶ worker: Chromium → A4 PDF
```

One function, one output, two destinations. There is no second path by which a
number could reach one rendering and not the other.

### Completed

- **`@rcln/documents`** — a new workspace package with **three** entry points,
  because three different questions have three different dependency footprints:
  `.` is how a document LOOKS (pure, browser-safe), `./store` is how it is KEPT
  (the `DocumentService` moved out of `apps/api`), `./data` is what it SAYS.
- **`@rcln/queue`** — `apps/worker/src/queues.ts`, extracted. A queue has two
  ends and the API had just become the other one.
- **The invoice template** — TSX rendered with `renderToStaticMarkup` into a
  self-contained HTML document: inlined CSS, inlined typefaces, **not one
  external request**.
- **The worker renders it** — `playwright-core` driving the distribution's
  Chromium, one browser per process, one context per job.
- **`invoice_documents` gained `template_key` / `template_version`** — provenance
  for a reprint years later.
- **`InvoiceDocumentFrame`** in `apps/web` — the preview, which is the same
  string in a sandboxed iframe.

### Decisions worth knowing about

⚠️ **CHROMIUM IS IN THE WORKER AND NOT IN THE API, AND THAT IS THE ANSWER TO A
MEASURED PROBLEM RATHER THAN A PREFERENCE.** The api container is capped at 1g
and already exits 137 running its own test suite beside the dev server — the
resume section at the top of this document has said so for five phases. A browser
process per render lands on top of that. The worker is a separate container, its
`mem_limit` went 768m → 2g, `queues.ts` has carried the comment _"a slow PDF
render must never occupy a request handler"_ since before there was one, and
Phase 1 mounted the document folder into both containers **at an identical path**
specifically so a queued render could write where the API reads.

The cost is that the PDF is **asynchronous**, and the reason that cost is nearly
zero is the requirement itself: the UI renders the invoice from data the instant
it is issued, so nothing waits on a PDF to _see_ the document. Only Download
waits. `DocumentStatus.PENDING` and `DocumentError.NOT_READY` have existed since
Phase 1 for exactly this.

⚠️ **THE PREVIEW IS AN IFRAME, AND THE IFRAME IS THE FEATURE.** Rendering
`<InvoiceDocument />` into the app's own DOM would put the document under
`globals.css`, Tailwind's preflight and whatever a parent screen sets — so the
preview would be styled by the app and the PDF would not, and the difference
would be a layout somebody reconciles by eye. `srcdoc` gives the document its own
cascade and its own `@page` box. It is also `sandbox=""`, which costs nothing
because the document has no scripts and means a template that one day
interpolated something unescaped could not become an XSS against the session.

⚠️ **THE FONTS ARE COMMITTED AS BASE64 AND NOT READ FROM `node_modules`, BECAUSE
EVERY FAILURE OF THE OBVIOUS IMPLEMENTATION IS SILENT.** The same template is
rendered in three processes — the API, the worker, Next's server runtime — and a
`readFileSync` into `@fontsource/...` is a different gamble in each: a bundler
does not trace a runtime path, `pnpm deploy --prod` prunes a devDependency, Next
inlines server code unless the package is externalised by name. A missing
`@font-face` src does not throw. The browser falls back, the page renders, and
the only symptom is that the PDF is set in something other than the preview the
clinic approved — which is precisely the drift this whole design exists to
prevent. `scripts/build-fonts.mjs` generates the constants; `fonts:check` fails
if they are stale.

⚠️ **THE `latin-ext` SUBSET IS NOT AN OPTIMISATION AND DROPPING IT LOSES THE
RUPEE SIGN.** Google's `latin` range stops at U+20AC (the euro). ₹ is U+20B9,
which lives in `latin-ext`'s U+20AD-20C0. An India-first product whose invoices
cannot print their own currency symbol would be a remarkable thing to ship, and
the failure is a missing-glyph box on a tax document rather than an error
anywhere. Pinned by a test asserting the range is declared. This is also what
made the font decision non-negotiable: the alternative PDF-library route would
have needed a vendored TTF for the same reason, since ₹ is not in WinAnsi either.

⚠️ **WHAT THE DOCUMENT CALLS ITSELF IS DATA, NOT A STRING.** Under GST a
registered clinic supplying an **exempt** service issues a _Bill of Supply_, not
a _Tax Invoice_ — and healthcare services in India are exempt, which makes it the
single most common line a clinic bills. A clinic holding no registration issues a
plain _Invoice_ everywhere, because "Tax Invoice" asserts a registration it does
not have. "Tax Invoice" is also correct in Australia, Singapore, New Zealand and
the UAE and is **not** how the UK or Ireland head one. This is Phase 2b's lesson
in the title bar: the arithmetic was right on a non-compliant document, and every
total-based assertion passed.

⚠️ **THERE IS NO `timeFormat` ON THE DOCUMENT, AND REMOVING IT REMOVED A WHOLE
DEPENDENCY.** An invoice is **dated**, not timestamped — GST and every other
regime here require the date of issue and none requires the minute. Printing only
the date is the better document, and the consequence is that the loader no longer
needs `resolveSettings`, which is an `apps/api` service the worker cannot import.
⚠️ The simplification is a _consequence_, not the motive; the motive is that a
clock face on a tax document is noise on the line an auditor reads. A document
type that genuinely needs a time — a prescription, a lab report — adds the field
when it has a consumer for it.

⚠️ **`DocumentService` HAD TO LEAVE `apps/api`, AND `resolveSettings` SHOWED WHY
THAT IS NOT FREE.** A document is now WRITTEN by the worker and SERVED by the
API: one `files` table, one folder, two processes. A service constructible only
from one app's config would have forced the worker to reimplement the
row → bytes → READY ordering the whole design rests on. So its configuration is
injected at boot by each app, exactly as `configurePayments()` already does for
the same pair of processes. The loader moving out then collided with
`resolveSettings` — see the decision above for how that resolved.

⚠️ **THE JOB PAYLOAD CARRIES IDS AND NOTHING ELSE, AND THE CONSUMER RE-READS
UNDER RLS.** A BullMQ payload is JSON in Redis — which is configured
`noeviction` and persists to disk — echoed into the log line of every failure and
kept in the dead-letter queue for seven days. A customer name in it would be a
customer name in all three. The worker builds `InvoiceDocumentData` itself,
inside `withTenant`, with `branchIds` narrowed to the **one** branch the invoice
belongs to.

⚠️ **THE RENDER IS ENQUEUED AFTER THE TRANSACTION COMMITS, AND A FAILED ENQUEUE
DOES NOT FAIL THE REQUEST.** Enqueue inside the transaction and the worker — a
different process, already awake, faster than a commit — goes looking for an
invoice its snapshot cannot see yet: an intermittent "not found" on a document the
API just created, roughly never in development. And by the time the enqueue runs
the invoice has a number and frozen totals: it **is** a document. Throwing would
report failure for something that succeeded, and the cashier's reasonable
response — press Issue again — is refused by the lifecycle guard, leaving them
holding an invoice they have been told does not exist.

⚠️ **THE STORAGE KEY IS MADE UNIQUE PER ATTEMPT, AND THE FIRST VERSION OF THAT
WAS A COUNTER, WHICH WAS A BUG.** `files.storage_key` is UNIQUE and
`storeDocument` claims the row before writing bytes, so a retry at the same key
returns `ALREADY_EXISTS` — pointing at the FAILED row that is exactly what needed
replacing. The obvious fix is to number the attempts by counting the
`invoice_documents` already recorded for the invoice, and **it fails on the one
case the retry exists for**: the crash window between `storeDocument` returning
and the row write committing leaves a `files` row and NO `invoice_documents` row,
so the count is unchanged, the retry rebuilds the identical key, and it is
refused. Correct for every failure except the one it was written for. Found by
re-reading the code rather than by a test — there is no integration test that
crashes a worker mid-job — and replaced with a random suffix, which cannot
collide with a predecessor whether or not that predecessor was recorded.

⚠️ **THE SAME TRAP EXISTS ONE LEVEL UP, IN THE JOB ID.** BullMQ de-duplicates
while a job is queued, active **or recently completed** — right for a
double-clicked Issue button, and silently wrong for a deliberate regeneration,
which resolves against the old completed job, reports success and renders
nothing. `jobId.invoicePdf(id, attempt)` is the fix and it is pinned by a test.

⚠️ **JAVASCRIPT STAYS ENABLED IN THE RENDER CONTEXT, WHICH IS THE OPPOSITE OF THE
REFLEX.** The document has no `<script>` — a test asserts it — so disabling JS
would be free hardening. What it would also disable is `document.fonts.ready`,
the only way to know the embedded typefaces are decoded before `page.pdf()`
snapshots what is painted. A document set in the fallback produces no error and a
perfectly plausible PDF that does not match the preview. A real guarantee beat a
theoretical hardening against scripts the test says are not there.

⚠️ **THE PAGE SIZE IS IN THE CSS AND NOT IN A `format` OPTION.** `preferCSSPageSize`
is set and the stylesheet owns `@page { size: A4 }`, because the preview needs the
geometry too. Stating it in both places is two sources of truth for one
measurement, and the failure — a preview laid out for one paper size and a PDF
printed on another — is exactly the drift being designed out.

⚠️ **TWO RENDERS OF THE SAME INVOICE ARE NOT BYTE-IDENTICAL, AND THAT IS FINE.**
A PDF carries a CreationDate that Chromium takes from the wall clock, and this
Playwright's `page.pdf()` exposes no way to pin it. `files.checksum` is computed
over the bytes at the moment they are STORED and proves the document served today
is the one stored then — which is the actual requirement, and needs no
reproducibility, because an issued invoice's PDF is generated once.

⚠️ **`eslint --fix` REFORMATTED THE GENERATED FONT FILE, AND `fonts:check`
CAUGHT IT.** Prettier does not care about an `eslint-disable` banner, so the
141KB of base64 came back out differently from what the generator emits — and the
next `fonts:check` reported a file nobody had edited as stale. It is now ignored
in `packages/documents/eslint.config.js`. The repo rule was already this: never
hand-edit a generated file, and a formatter is a hand-edit with more steps. Worth
recording because the freshness check earned its place on the first run rather
than in theory.

⚠️ **THE NOT NULL COLUMNS BROKE FOURTEEN EXISTING ISOLATION CASES, WHICH IS THE
CONSTRAINT WORKING.** `tenant-isolation.test.ts` inserts `invoice_documents` rows
by hand to test the RLS boundary, and those inserts predate the template columns.
Every one of them failed with `null value in column "template_key"` — the exact
failure a DEFAULT would have hidden, on the exact rows a DEFAULT would have
mislabelled. The fix was to state the template in the fixtures, and two new cases
pin the constraint in both directions.

⚠️ **THE TEMPLATE NEVER COMPUTES A NUMBER.** Every amount is printed from the
snapshot. The temptation on a document like this is to sum the tax column "so the
page is always consistent", and that would be a second implementation of
`@rcln/invoicing` disagreeing with the database by a paisa in the cases that
matter. The one derived figure is the balance due, and only because there is no
column for it.

⚠️ **INDIAN AMOUNTS GROUP IN LAKHS, AND THAT IS A DELIBERATE DEVIATION FROM THE
ONE-PINNED-LOCALE RULE.** `apps/web/src/lib/format.ts` pins `en-GB` everywhere so
the server and the browser produce the same string; this template has to survive
the same string being produced by a Node container, a browser, AND a headless
Chromium in a third container. Determinism is the requirement, and one pinned
locale satisfies it while getting the largest market wrong: `1,23,45,678.00` is
how India writes money. The grouping locale is derived from `countryCode`, which
the snapshot already carries, so it stays deterministic in all three runtimes.
Dates stay `en-GB` throughout.

⚠️ **THE TAX SUMMARY GROUPS ON NAME _AND_ JURISDICTION _AND_ RATE.** CGST 6% and
SGST 6% are the same rate on the same base owed to two different governments;
merging them into one 12% row states a tax nobody levies, on the table a return is
filed from. Two rates under one component name is the same mistake in the other
direction. Both are pinned, and the summary is sorted — Postgres promises no row
order without an ORDER BY, and a reprint whose tax table came out in a different
order is a document a patient can reasonably say is not the one they were given.

#### The design

Minimal and tabular, entirely on the tokens `apps/web/src/app/globals.css`
already commits to — which turned out to have been written with this document in
mind: it says mono + `tabular-nums` is for "token, MRN, **GSTIN**, **HSN**, batch,
**invoice no.**", and this is where most of that list finally appears.

The signature is a rule system: every horizontal division is a 0.2mm hairline
**except exactly two**, which are 0.5mm `drape` — under the masthead and above
the grand total. Two heavy lines on the whole page, marking the only two questions
it answers: who is billing, and what is owed.

Three things were deliberately left out. `--font-display` (Plex Serif), because
globals.css restricts it to headlines and an invoice has no headline — a clinic's
name is a name. `--color-signal`, because it means "the thing happening now" and
an issued invoice is finished; the VOID watermark is outlined `ink` instead, and
outlined rather than filled so the line items stay legible underneath — a voided
invoice still has to be readable by whoever is reconciling it. And
`--color-paper` as the page, because a full-bleed tint costs toner on every print
and photocopies as grey.

The risk taken: the items table has **no vertical rules and no zebra striping**.
Column separation is carried entirely by tabular figures, right alignment and
widths fixed in millimetres that sum to the content width — the table algorithm is
never asked to guess, because a guess that resolves differently in the preview and
in print is the drift again.

### Files changed

- `packages/documents/**` — new: `invoice/{types,format,styles,document.tsx,render.tsx,samples,index}`,
  `store/{document.service,runtime,index}`, `data/{invoice-document.data,index}`,
  `fonts.ts`, `fonts.generated.ts`, `scripts/{build-fonts,preview}.mjs`, 1 test file
- `packages/queue/**` — new: `index.ts` (moved from the worker), `producer.ts`, 1 test file
- `apps/api/src/services/document/document.service.ts` — **moved** to the package
- `apps/api/src/services/document/storage.provider.ts` — **deleted**, replaced by
  the package's injected runtime
- `apps/api/src/services/document/store.ts` — new, the API's half of that config
- `apps/api/src/services/invoicing/issue-invoice.ts` — new, the finalise-then-enqueue seam
- `apps/api/src/services/invoicing/invoice-lifecycle.service.ts` — `branchId` on `FinalizedInvoice`
- `apps/api/src/queue/producer.ts` — new; `src/index.ts` boots the store and closes the producer
- `apps/worker/src/queues.ts` — **deleted**; `src/documents/{browser,pdf.renderer,invoice-pdf.job}.ts` — new
- `apps/worker/src/index.ts` — the `DOCUMENTS` processor, the store config, browser shutdown
- `apps/web/src/components/tenant/invoice-document-frame.tsx` — new
- `packages/db/prisma/schema.prisma` + `migrations/20260811120000_invoice_document_template_provenance/` — new
- `infra/docker/Dockerfile.dev`, `apps/worker/Dockerfile`, `docker-compose.yml` — chromium, memory, shm
- `apps/api/tests/integration/invoice-document.test.ts` — new, 11 cases
- `apps/api/tests/integration/tenant-isolation.test.ts` — the `invoice_documents`
  fixtures state their template, plus 2 cases pinning the new constraint
- `packages/documents/eslint.config.js` — the generated font file is ignored

### Database changes

`invoice_documents` gains `template_key` (varchar 64) and `template_version`
(smallint), both NOT NULL with **no default** — the table has never had a writer,
so there is nothing to backfill, and a default would stamp `('invoice', 1)` onto
a row that predates templates: an answer that is confident, wrong, and
indistinguishable from a real one. Plus a CHECK that the version is positive.

No new table, so no RLS policy. `db:rls:check` unchanged at 48.

### API changes

None yet — `issueInvoice()` is the seam and Phase 7 is the first route to call
it. `billing.invoice.*` still gates nothing.

### Tests added

- `packages/documents/tests/invoice-template.test.ts` — 21 cases: what the
  document calls itself in four jurisdictions, lakh grouping, a zero-decimal
  currency, Quebec's 9.975%, the ₹ unicode-range, the invoice number in the title
  and never the patient, and **the measured claim of the whole design** — that the
  rendered HTML makes no external request of any kind.
- `packages/queue/tests/job-id.test.ts` — 10 cases: the regeneration id, and no
  colons anywhere.
- `apps/api/tests/integration/invoice-document.test.ts` — 11 cases against real
  Postgres: the snapshot beating a renamed organization, both halves of a split
  kept apart, two rates under one component kept apart, deterministic ordering,
  minor units for real money, and another tenant's invoice as a 404.
- `apps/api/tests/integration/tenant-isolation.test.ts` — 2 cases: a document that
  does not say which template drew it, and a version that is not a positive
  count.

### Known issues

- ⚠️ **The Alpine Chromium moves with the base image, not with the lockfile.**
  `playwright-core` drives the distribution's browser because Playwright's own
  build is glibc and this base is musl — its binary installs fine and then cannot
  start. The consequence: a layout regression can arrive from a `docker build`
  with no change in `pnpm-lock.yaml`.
- ⚠️ **Devanagari, Tamil, Kannada and every other non-Latin script render as
  missing-glyph boxes.** The vendored subsets are Latin. The render job LOGS the
  count and the script name — never the characters, which are a patient's name —
  so the gap is known rather than silent. The fix is another `@font-face`: CSS
  falls back natively and globals.css already notes IBM Plex has a metrically
  matched Devanagari sibling. It is a file and a row in a table, not a redesign.
- **No route serves the PDF.** Phase 7. `readDocument` already returns
  `NOT_READY` for a render still in flight, which is the contract the download
  route will expose.
- **No screen renders the preview.** `InvoiceDocumentFrame` exists and has no
  caller — the screen is Phase 9 and the `GET /invoices/:id/document` it needs is
  Phase 7. Same shape as `DocumentService` at the end of Phase 1.
- **Nothing sweeps a failed render.** Five attempts, then the invoice has no
  current document and nothing asks again. `requestInvoicePdf(ctx, job, attempt)`
  is the retry and it has no scheduler. It wants the same job that will clean up
  stuck `GENERATING` rows.
- **A regeneration has no actor.** `InvoicePdfJob.requestedBy` is required, so a
  future sweep has to decide what to put there rather than defaulting it away —
  the problem the billing runtime solved by having no audit hook at all.
- **The preview renders in the viewer's browser and the PDF in ours.** On Safari
  or Firefox they can differ by a hair. Mitigated by a plain table with mm widths
  and one embedded font, and by Download always serving the **stored** PDF — the
  patient always gets the Chromium one.
- **The dev image carries Chromium for every service.** ~500MB of image the api
  and web containers never execute. The alternative is a second dev image and the
  stale-image footgun the compose header warns about; memory, which was the actual
  problem, is unaffected.
- Pre-existing schema drift, unrelated and untouched: `prisma migrate diff` still
  reports the two `appointment_vitals` constraint/index renames left by
  `20260809180000_vitals_revisions`.

### Next phase

**Phase 7 — invoice APIs.** list/detail/PDF/create/finalize/cancel, pagination,
filters, the §0.7 visibility rule, typed errors. It is the first caller
`issueInvoice()` has, the first route to serve a stored PDF, and the place
`GET /invoices/:id/document` returns the very `InvoiceDocumentData` this phase
built — which is what lets Phase 9's screen render the same document the worker
printed.

---

## Phase 7 — Invoice APIs

**Complete.** **785 API tests** green (was 757) — 475 in the first split, 310 in
the second; **28 new** in `invoices.test.ts`. 39 permissions, 63 tax, 35
invoicing, 40 billing, 34 storage, 21 documents and 10 queue tests unchanged and
green; `db:rls:check` unchanged at **48** protected tables; repo-wide lint clean
(23 tasks) and typecheck clean; api and worker containers healthy.

**Verified end to end, not reasoned about:** `POST /v1/invoices` →
`POST /v1/invoices/:id/issue` → `INV-2026-OTH-MAIN-000001` → the job on
`QUEUE.DOCUMENTS` → the worker's Chromium → `GET /v1/invoices/:id/pdf` serving
**63,907 bytes beginning `%PDF-`**, as
`inline; filename="INV-2026-OTH-MAIN-000001.pdf"`. Done over real HTTP against
the running worker, with a throwaway suite that was deleted afterwards — it
depends on a rendering worker being up, which is an environment fact and not a
property of this code.

### Completed

- **Nine routes** at `/v1/invoices` — list, detail, document-as-data, PDF,
  create, replace, issue, cancel, void.
- **`billing.invoice.read_all`** — the §0.7 rule, resolved once per request and
  applied by the list, the detail, the document and the PDF alike.
- **`invoice-visibility.ts`** — which SOURCES a caller may see, derived from the
  modules they already work in.
- **`invoice.service.ts`** — the read and orchestration half: transactions,
  calendar dates → instants, `numeric` → minor units, the disclosure trail.
- **`updateDraftInvoice`** — the whole-document replace `repriceDraftInvoice`
  was built for, in the lifecycle service where the other writes live.
- **`packages/contracts/src/invoices.ts`** — and `calendarDate` moved into
  `common.ts`, where it should have been at its second copy.

### Decisions worth knowing about

⚠️ **THE VISIBILITY RULE IS A SET INTERSECTED WITH THE CALLER'S FILTER, NEVER A
DEFAULT FOR IT.** `?sourceType=PHARMACY` from a desk clerk resolves to an empty
`IN ()` and returns nothing — not everything, which is what a "default" would
have produced the first time somebody passed the parameter explicitly. This is
the same failure shape as the `?doctorProfileId=` override in the patient
search, and it is pinned by a test that asks for exactly that.

⚠️ **AND WHERE IT SAYS NO, IT SAYS 404.** A 403 on an invoice id confirms the
invoice exists and, worse, confirms what KIND it is: "you may not read pharmacy
invoices" plus a 403 tells the caller this id is a pharmacy invoice. Whether a
caller's role covers a source is a fact about them and belongs in the UI; that
an invoice exists is a fact about the clinic's business and belongs to nobody
who may not read it. Under RLS another tenant's row already answers this way, so
there is exactly one shape of "no" on this surface.

⚠️ **`billing.invoice.read_all` IS ONE CODE AND NOT SEVEN, AND ORG_OWNER GETS IT
FOR FREE — WHICH IS THE OPPOSITE OF INVARIANT 7'S TREATMENT AND CORRECT HERE.**
`CLINICAL_AUTHORING` is stripped from the "everything except" roles by name
because writing in a chart is an act a clinician signs. Reading the ledger is
not: an owner who cannot see the pharmacy's own invoices cannot run the clinic.
The code exists to widen, so a new source needs no re-grant anywhere; the roles
that hold it are the accountant and the branch administrator, plus the two
"everything except" roles by construction.

⚠️ **ISSUING IS `billing.invoice.create`, AND THE ALTERNATIVE WAS A NEW CODE.**
Raising the bill and handing it over are one act at a counter — a receptionist
who could open a draft and never issue it would have half a job, and both
RECEPTIONIST and PHARMACIST hold `create` without `update`. A `billing.invoice.issue`
would be more precise and would also be a code no seeded role could sensibly be
given without also being given `create`, which makes it a distinction the
permission matrix records and nobody uses. `cancel` covers both abandoning a
draft and voiding an issued document, and the void route demands a reason where
cancel does not.

⚠️ **A CALENDAR DATE BECOMES **LOCAL MIDDAY**, AND BOTH OBVIOUS CHOICES ARE
WRONG.** `suppliedOn` is read twice by two different rules. The DOCUMENT prints
it in `branches.timezone`, so it must fall on the intended day there — UTC
midnight prints as the previous day everywhere west of Greenwich. And
`loadTaxContext()` compares it against `tax_rules.effective_from`, a `DATE`
column that comes back as UTC midnight — so local midnight in IST is
`2026-03-31T18:30Z`, which is BEFORE a rule effective 1 April, and the new rate
silently does not apply on the first day it is in force. Local midday satisfies
both for every zone within ±12 hours. It is stated once, in `branchInstant`,
rather than being rediscovered per call site.

⚠️ **THE LIST'S DATE FILTER IS TWO BRANCHES OF AN `OR`, BECAUSE A DRAFT HAS NO
ISSUE DATE.** Filtering on `issued_at` alone hides every draft from every range —
and a draft is the state a cashier is most likely to be hunting for. Both bounds
convert in the branch's zone when the query names one and in UTC when it does
not: a range across branches in two zones has no single local midnight, and
quietly using the first branch's would be a lie about the others.

⚠️ **THE WRITES ANSWER WITH THE PRICED DOCUMENT AND DO **NOT** FILE A DISCLOSURE
ROW FOR THAT READ-BACK.** Every write here re-reads the invoice, because the
engine's numbers are the point — echoing the request back would show the cashier
their own figures and hide the tax, the apportionment and any unrated line.
Logging that echo would file `data_access_logs` rows against people reading
their own work, on the route `POST /v1/invoices`, and a review of who read whose
chart would be mostly noise. Same rule `patient.service.ts` states: a creation is
a write, and `audit_logs` has it. Caught by a test that asserted the route
pattern and got `POST /v1/invoices` back.

⚠️ **THE LIST HAS NO `?q=`, AND ITS ABSENCE IS THE DESIGN.** The obvious search
parameter is a customer name, and a name in a query string is a name in
`data_access_logs.route`, in every proxy's access log, in the browser history and
in the referrer of the next request. `patients.routes.ts` moved its duplicate
probe to a POST for exactly this. An invoice is found by number, patient, branch,
status or date — all ids, enums and dates.

⚠️ **CREATING A DRAFT WITH A WHOLE-BILL DISCOUNT WAS SILENTLY WRONG SINCE PHASE
5, AND ONLY A ROUTE COULD HAVE SHOWN IT.** `createDraftInvoice` wrote the
discount's three input columns and did not pass the discount to the engine, so
`invoice_discount_total` and every `apportioned_discount` came back zero. It was
invisible because finalisation re-prices from the stored inputs: every ISSUED
invoice was right, and the only wrong number was the one the cashier was looking
at while deciding whether to give the discount. Fixed in the same call the
columns are written in, and pinned by a test.

⚠️ **AN EDIT PRICES IN THE INVOICE'S CURRENCY, NOT THE ORGANIZATION'S.** A
`Money` cannot be built without a currency, so the route has to resolve one
BEFORE the service sees the request — and the obvious source, the organization's
own currency, is right for a create and wrong for every edit of a draft opened in
anything else. The currency is fixed when the draft is opened and cannot be
changed by an edit, so `PUT` reads it off the row. The symptom of getting it
wrong is a currency-mismatch error raised from inside the pricing engine on a
request that was perfectly valid, and only ever for the invoices that are not in
the house currency.

⚠️ **THE ERROR CODE DOES NOT REACH THE WIRE, AND THAT IS PRE-EXISTING.**
`sendError` sends `{ success, message }` — `AppError.code` is never serialised —
so a client distinguishes `DOCUMENT_NOT_READY` from any other 409 by its message.
Adding `code` to the envelope is additive and touches every route in the product,
which makes it its own change with its own review rather than a side effect of
this one. Recorded under Known issues.

⚠️ **THE PDF ROUTE CHECKS, LOGS AND 404s BEFORE A BYTE IS READ.** `readDocument`
takes a file id and knows nothing about invoices or about who may see one, so
`recordInvoicePrint` does the visibility check and writes the `PRINT` row first
and hands back only the id. The bytes are served `inline` with the invoice
NUMBER as the filename — never the patient's name, which would survive into every
folder, mail attachment and screen share the file reaches — and under
`Cache-Control: private, no-store`.

⚠️ **THE STORE IS CONFIGURED AT BOOT AND NOT BY `createApp()`, WHICH COSTS A
TEST SUITE ONE UNEXPLAINED 500.** `initDocumentStore()` lives in `src/index.ts`,
so a process that only builds the app has no storage provider and the PDF route
fails as a generic 500 with nothing about invoices in it. `documents.test.ts`
already called it; `invoices.test.ts` now does too, with the reason written down.

⚠️ **THE GROUPING KEY FOR THE TAX SUMMARY IS `JSON.stringify`, NOT A JOIN ON A
SEPARATOR.** Every separator is a character a tax component's name could contain,
and two rows merged by a collision is a rate nobody levies on the table a return
is filed from. The first version used `\0`, which cannot collide and also turned
the source file into something `grep` reports as binary.

### Files changed

- `packages/contracts/src/invoices.ts` — new; `common.ts` gains `calendarDate`
  and `appointments.ts` imports it instead of declaring its own; `index.ts`
- `packages/permissions/src/codes.ts` — `INVOICE_READ_ALL`; `roles.ts` — granted
  to BRANCH_ADMIN and ACCOUNTANT (ORG_OWNER and ORG_ADMIN have it by
  construction)
- `apps/api/src/services/invoicing/invoice-visibility.ts` — new
- `apps/api/src/services/invoicing/invoice.service.ts` — new
- `apps/api/src/services/invoicing/invoice-lifecycle.service.ts` —
  `updateDraftInvoice`, plus the create-discount fix
- `apps/api/src/routes/v1/invoices.routes.ts` — new; mounted in `index.ts`
- `apps/api/tests/integration/invoices.test.ts` — new, 28 cases

### Database changes

**None.** Phase 7 is a surface on the model Phases 3–6 built. No migration, no
new table, no RLS policy — `db:rls:check` unchanged at 48.

### API changes

Nine routes, all behind `requireTenant → authenticate → requireAuth →
authorize → validate`:

| Method | Path                        | Permission               |
| ------ | --------------------------- | ------------------------ |
| GET    | `/v1/invoices`              | `billing.invoice.read`   |
| GET    | `/v1/invoices/:id`          | `billing.invoice.read`   |
| GET    | `/v1/invoices/:id/document` | `billing.invoice.read`   |
| GET    | `/v1/invoices/:id/pdf`      | `billing.invoice.read`   |
| POST   | `/v1/invoices`              | `billing.invoice.create` |
| PUT    | `/v1/invoices/:id`          | `billing.invoice.update` |
| POST   | `/v1/invoices/:id/issue`    | `billing.invoice.create` |
| POST   | `/v1/invoices/:id/cancel`   | `billing.invoice.cancel` |
| POST   | `/v1/invoices/:id/void`     | `billing.invoice.cancel` |

Every one of them is additionally narrowed by the source set
`billing.invoice.read_all` escapes.

### Tests added

`apps/api/tests/integration/invoices.test.ts` — 27 cases over real HTTP: the
draft priced at creation including its whole-bill discount, GST split into two
rows, the branch code in the number, the 409 on editing an issued invoice, the
unrated refusal, cancel-vs-void in both directions, the visibility rule at all
three doors **including the caller's own `?sourceType=` filter**, pagination and
the exact-number filter, a draft found by date, the document route returning what
the worker renders from, the draft PDF as a 409, and the disclosure trail — a row
for the detail read, none for a write's read-back, and no customer name anywhere
in the table.

⚠️ **ONE OF THOSE CASES PASSED FOR THE WRONG REASON FIRST, AND THE FIX IS THE
27th.** "The owner sees the pharmacy invoice" passed while
`billing.invoice.read_all` was not in the database at all — ORG_OWNER is
"everything except", so it holds `pharmacy.dispense.read` and saw the invoice
through the MODULE rule. A test that passes with the feature removed is not a
test of the feature. The auditor role — `billing.invoice.read` plus
`read_all`, and not one module code — is the one that actually exercises the
escape hatch.

### Known issues

- **`AppError.code` never reaches the client.** `sendError` sends
  `{ success, message }`. `DOCUMENT_NOT_READY` is a 409 whose message is the only
  way to tell it from any other 409. Additive to fix and it touches every route.
- **No payments, so `amount_paid` is always zero.** `balanceDueMinor` is
  therefore always the grand total, `PARTIALLY_PAID` and `PAID` are unreachable
  through any route, and a void can never involve money. The payments table is
  where that changes.
- **No credit note.** Voiding an issued invoice under GST wants one; there is no
  table, no series and no `CREDIT_NOTE` source type. `reason` is what a clinic
  has until then. Deferred since Phase 5.
- **A failed render still has no retry route.** `requestInvoicePdf(ctx, job,
attempt)` exists and nothing calls it a second time, so five failures leave an
  ISSUED invoice with no document and nothing asking again. It wants the same
  scheduled job that will sweep stuck `GENERATING` rows.
- **The list is offset-paginated.** Fine at a clinic's volume and wrong at the
  page depth a year of invoices reaches; the `(createdAt, id)` ordering is
  already the keyset a cursor would use.
- **`cashRoundingMinor` is still a request parameter and not a setting.**
  `resolveSettings()` has no billing key for it, so a clinic that rounds to the
  rupee must send it on every request. It belongs with the billing settings
  screen, which is Phase 9's neighbourhood.
- **Nothing bills an appointment yet.** `sourceType: APPOINTMENT` works and the
  composite FK holds, but the appointment screen has no "raise invoice" path —
  that is Phase 8.

### Next phase

**Phase 8 — appointment billing.** The first integrated source: a consultation
becomes an invoice without anybody retyping the fee, which means a service
catalogue or at least a consultation-fee setting to price it from, and the
"is this visit already billed?" question answered against the LIVE invoice
rather than against `appointment_id`, which is deliberately not unique.

**Phase 8 — appointment billing.** Done; see below.

---

## Phase 8 — Appointment billing

**Complete.** **806 API tests** green (was 785) — 496 in the first split, 310 in
the second; **21 new** in `appointment-billing.test.ts`. 63 tax, 35 invoicing,
40 billing, 34 storage, 21 documents and 10 queue tests unchanged and green;
`db:rls:check` unchanged at **48** protected tables; repo-wide lint clean (23
tasks) and typecheck clean; api and worker containers healthy.

⚠️ **THE RATE CARD ALREADY EXISTED, WHICH IS WHY THIS PHASE HAS NO MIGRATION.**
`doctor_branch_settings.consultation_fee` / `follow_up_fee` /
`follow_up_free_days` have been in the schema since the doctors phase, settable
through `PUT /v1/doctors/:id/branch-settings`, rendered on the doctor profile —
and read by nothing. The plan's "a service catalogue or at least a
consultation-fee setting to price it from" was already answered; building a
`services` catalogue here would have been a second rate card for the one thing
that already had one. A catalogue arrives with PROCEDURE and SERVICE, which need
it and have nothing.

### Completed

- **`GET /v1/appointments/:id/billing`** — the preview: the fee off the rate
  card, the day of supply, the live invoice and the full history.
- **`POST /v1/appointments/:id/invoice`** — the draft, in one call with no body.
- **`liveInvoice` on the day board and the appointment detail** — one query for
  the whole board, behind `billing.invoice.read`.
- **`appointment-billing.service.ts`** — fee resolution, the free-review window,
  the live-invoice rule, and the lock that makes it hold.
- **`packages/contracts/src/invoices.ts`** — `appointmentBilling`,
  `appointmentInvoiceLink`, `consultationCharge`,
  `createAppointmentInvoiceRequest`; `appointments.ts` gains the optional link.

### Decisions worth knowing about

⚠️ **"IS THIS VISIT BILLED?" IS A QUESTION ABOUT THE LIVE INVOICE, AND THE
OBVIOUS FIX IS THE WRONG ONE.** `invoices.appointment_id` is not unique on
purpose — a visit billed, voided and re-billed has two rows, and the void keeps
its reference or the correction cannot be explained. So `LIVE_STATUSES`
(everything except CANCELLED and VOID) is the whole definition of "billed", and
it is stated once and consulted by the preview, the create and the board alike.
The tempting alternative, a partial unique index over the live statuses, would
be correct on the day and would refuse the second bill after a void the moment
`amount_paid` is ever non-zero and the void is the right answer.

⚠️ **AND BECAUSE THERE IS NO UNIQUE INDEX, THE CHECK IS A RACE, SO THE
APPOINTMENT ROW IS LOCKED `FOR UPDATE`.** Two cashiers pressing Raise invoice on
one visit is an ordinary Monday at a busy front desk, and a read-then-insert
across two connections produces two live drafts with nothing to say which is
real. The lock is on `appointments` rather than on `invoices` because the row
being contended for is the visit; it is held for one pricing round trip and
released by COMMIT. This is the same shape as `issueNumber()`'s row lock and the
only other place in the invoicing code that serialises anything.

⚠️ **THE DATE OF SUPPLY IS THE VISIT'S BRANCH-LOCAL DAY, NOT `now()`, AND IT IS
THE ENTIRE REASON THIS ENDPOINT BEATS TYPING THE INVOICE BY HAND.** It selects
the effective-dated `tax_rules` row and the registration, so a bill raised in
April for a March consultation is taxed as March was. `now()` would pass every
other assertion in the suite, which is why the tests book every visit in a year
the suite will never run in.

⚠️ **A NULL `follow_up_fee` FALLS BACK TO THE CONSULTATION FEE AND DOES NOT MEAN
FREE.** The rate-card screen presents the two independently and most clinics fill
in one. Reading the blank as zero would bill every review at nothing, silently,
at every clinic that never opened the second field — and a zero on a bill looks
settled. A deliberate zero is a zero, which the column can hold.

⚠️ **`FOLLOW_UP_FREE` IS A CHARGE OF ZERO, NOT AN ABSENT CHARGE, AND THE
DISTINCTION IS THE WHOLE SHAPE OF THE RESPONSE.** `follow_up_free_days` is an
answer the clinic gave; a doctor whose card was never filled in is a different
fact and leaves `charge` null with an `unpricedReason`. Collapsing them would
make "we waive this" and "we have not decided" the same value on the screen
where the cashier decides.

⚠️ **AN UNPRICED VISIT REFUSES RATHER THAN BILLING ZERO, AND `unitPriceMinor` IS
THE WAY THROUGH.** A draft at zero from a rate card nobody filled in is a bill
that looks paid. The override exists so a clinic that has not configured fees can
still use this door, and it confers nothing `billing.invoice.create` did not
already carry through `POST /v1/invoices` — which is also why there is no
`appointment.invoice.create` code. Everything richer than one consultation line
is the generic route; this one is a shortcut through it, not a replacement.

⚠️ **A FOLLOW-UP IS EITHER STRUCTURE OR INTENT, AND ONLY STRUCTURE CAN MEASURE
THE WINDOW.** `parentAppointmentId` is the chain the database enforces;
`visitType = FOLLOW_UP` is what the desk typed when the return was not linked.
Both charge the follow-up fee — ignoring the second would charge the new-patient
rate to somebody explicitly marked a review — but only the first has a previous
visit to measure the free window from, and each end of that measurement is read
in **its own branch's** zone, because a review in Dubai off a visit in Bengaluru
is two zones and one of them is a day out at the boundary.

⚠️ **A NO-SHOW IS BLOCKED, AND A NO-SHOW FEE IS A REAL THING.** Those are not in
tension: a missed appointment is not a consultation, so this endpoint must not
quietly bill an absent patient the consultation fee. A clinic that charges for
the miss raises it through `POST /v1/invoices` at the amount it decided on.

⚠️ **THE BOARD'S `liveInvoice` IS ABSENT, NOT NULL, FOR A CALLER WITHOUT
`billing.invoice.read`.** Three states, and the third is the key not being there:
object means billed, `null` means unbilled, missing means nobody asked. Sending
`null` to a caller who was never allowed to know would read as "nothing has been
billed today", which is a claim rather than a silence.

⚠️ **THE PREVIEW WRITES NO `data_access_logs` ROW, AND THE BILL ITSELF STILL
DOES.** It carries ids, a fee and an invoice state — no name, no line
description, nothing clinical. Logging it would file a row on every render of the
board's billing column, which is the per-poll firehose `invoice.service.ts`
already explains it is avoiding. `GET /v1/invoices/:id` is where the disclosure
is, and it logs.

⚠️ **THE SEEDED `DOCTOR` ROLE HOLDS `billing.invoice.read`, AND THE FIRST DRAFT
OF THE TEST SUITE DID NOT KNOW THAT.** "A doctor cannot see the billing column"
is false — a clinician does see what the visit cost — so the board assertion
passed against an empty board (a `DOCTOR` member with no profile gets their own
diary, which is nothing) rather than against a caller who was refused the
column. A purpose-built `BOARD_ONLY` role with `appointment.read` plus
`doctor.directory.read` and no billing code is what actually exercises the rule.

### Files changed

- `packages/contracts/src/invoices.ts` — the appointment-billing shapes;
  `appointments.ts` — `liveInvoice` on `appointmentSummary`, plus the import
- `apps/api/src/services/invoicing/appointment-billing.service.ts` — new
- `apps/api/src/services/invoicing/invoice.service.ts` — `readInvoice` renamed
  and exported as `readInvoiceDetail`; `branchInstant` exported
- `apps/api/src/services/invoicing/invoice-lifecycle.service.ts` —
  `organizationCurrency` exported, so the two paths default to one currency
- `apps/api/src/services/appointment/appointment.service.ts` —
  `DayBoardScope.withBilling`, the same flag on `getAppointment`, `detailOf`
- `apps/api/src/routes/v1/appointments.routes.ts` — two routes; the board and the
  detail resolve `billing.invoice.read`
- `apps/api/tests/integration/appointment-billing.test.ts` — new, 21 cases

### Database changes

**None.** No migration, no new table, no column, no RLS policy —
`db:rls:check` unchanged at 48. Every column this phase reads was already there.

### API changes

| Method | Path                           | Permission               |
| ------ | ------------------------------ | ------------------------ |
| GET    | `/v1/appointments/:id/billing` | `billing.invoice.read`   |
| POST   | `/v1/appointments/:id/invoice` | `billing.invoice.create` |

Plus `liveInvoice` on `GET /v1/appointments` and `GET /v1/appointments/:id`,
present only for a caller holding `billing.invoice.read`.

### Tests added

`apps/api/tests/integration/appointment-billing.test.ts` — 21 cases over real
HTTP: the fee read off the rate card, the day of supply being the visit's day and
not today, the draft citing the visit with the patient's name, phone and primary
address snapshotted, the second bill refused, the visit becoming billable again
after a cancel AND after a void with the number surviving, the free window and
the review outside it, `NO_RATE_CARD` vs `NO_FEE_SET` vs the override, a
cancelled visit refused, and the board's column present for one caller and
**absent** for another.

### Known issues

- **No screen.** The Raise invoice button and the billing column are Phase 9,
  with the invoice module they would link into. This phase is the API under them.
- **`suppliedOn` cannot be overridden.** It is the visit's day, full stop. A
  clinic that means a different date edits the draft — which is right, but it
  means a correction is two calls.
- **The consultation line has no `itemCode`.** The SAC for healthcare services is
  9993 and a clinic that prints it has to add it to the draft by hand. It belongs
  on the rate card, which has no column for it.
- **PROCEDURE and SERVICE still have nothing to price them.** They are the two
  sources with no reference column and no catalogue; `visitType = PROCEDURE` on
  an appointment is still billed as a consultation from this door.
- **Nothing re-prices a draft when the rate card changes.** The draft holds the
  fee as it was when it was opened; finalisation re-prices the TAX from the
  stored inputs but never the fee. That is correct — the fee is an input the
  cashier can see and change — and it is worth knowing.
- **A no-show fee has no path of its own.** Blocked here by design, and the
  generic route is the answer until somebody decides a clinic wants a policy.

### Next phase

**Phase 9 — the frontend invoice module.** The list, the detail with the
document preview in an `iframe srcdoc`, the draft editor, and the Raise invoice
path this phase built the API for. It is also where two Phase 7 known issues
land: `cashRoundingMinor` becoming a billing setting rather than a request
parameter, and the tenant rate-card screen that `tax_rules` has had no UI for
since Phase 2c.

---

## Phase 9 — Frontend invoice module

**Complete.** **833 API tests** green (was 806) — 523 in the first split, 310 in
the second; **27 new** (25 in `clinic-tax.test.ts`, 2 in `invoices.test.ts`). 63
tax, 35 invoicing, 40 billing, 34 storage, 21 documents, 10 queue, 39 permissions
and 95 payments package tests green; `db:rls:check` unchanged at **48** protected
tables; repo-wide typecheck and lint clean (34 turbo tasks plus `apps/api`'s two
`tsc` passes run separately); api and worker containers healthy.

⚠️ **THE PHASE 6 PREVIEW FRAME HAD NEVER BEEN IMPORTED, AND THE FIRST SCREEN TO
IMPORT IT FAILED `next build` OUTRIGHT.** `invoice-document-frame.tsx` shipped in
Phase 6 as a Server Component calling `renderInvoiceHtml`, which reaches
`react-dom/server` — and Next declines that in a Server Component's module graph.
Moving it to a Route Handler failed identically: Turbopack applies the same rule to
App Routes. Typecheck was clean throughout both attempts. The render therefore
moved to the API, as `GET /v1/invoices/:id/preview`, and the web is now a conduit
for both representations of an invoice rather than the renderer of one and the
proxy of the other — which is the better arrangement in any case, and it is what
`pnpm validate` cannot tell you, because `next build` is not in it.

### Completed

- **`/invoices`** — the ledger: URL-param filters (status, source, branch, exact
  number, date range), offset pagination, a two-state empty screen.
- **`/invoices/:id`** — the document in a sandboxed iframe, the totals and tax
  summary broken out, the provenance block, and Issue / Cancel / Void behind
  in-flow confirmations rather than a modal.
- **The draft editor** — the whole-document `PUT`, with money typed in major units
  and converted on save. Reached from the detail screen only.
- **`/invoices/:id/pdf` and `/preview`** — two Route Handlers that forward the
  API's bytes, because the access token is in an httpOnly cookie on this host.
- **The Raise invoice path** — a billing panel on the consultation screen and a
  billing column on the day board, off Phase 8's two endpoints.
- **`billing.cash_rounding_minor`** — Phase 7's known issue, and it was worse than
  recorded: see the decisions below.
- **`/v1/tax` and `/taxes`** — the tenant rate card. Registrations and rules, the
  first write path either table has ever had, plus the screen `tax_rules` has had
  no UI for since Phase 2c.

### Decisions worth knowing about

⚠️ **`cashRoundingMinor` WAS NOT MERELY "A PARAMETER THAT SHOULD BE A SETTING" —
IT WAS SILENTLY BROKEN, AND ONLY MAKING IT A SETTING FIXES IT.** It arrived on the
create and update bodies and was never stored, so `finalizeInvoice`, which
re-prices from the stored inputs, re-priced **without** it. A clinic rounding to
the rupee saw a rounded total on the draft and handed the patient an unrounded
document, with nothing on either screen saying they disagreed. A per-request value
cannot survive a re-price it is not stored for. It is now resolved inside
`priceDraftInvoice` — the one function every pricing path goes through, so create,
edit, re-price and finalise all agree — and the request field is **gone from the
contract**, because a field that cannot survive finalisation has no business on a
body.

⚠️ **`.partial()` KEEPS `.default()`, WHICH MADE EVERY DESCRIPTION-ONLY PATCH A
SILENT REWRITE — INCLUDING ON THE PLATFORM'S OWN RATE CARD.** Zod's `.partial()`
makes a key optional and leaves any default in place, so `{ description }` parses
to `{ description, treatment: 'STANDARD', split: 'NONE', stacks: false }` and the
service writes exactly the keys it receives. Renaming India's split GST rule would
have unsplit it. Found because the new tax suite's "a description still saves"
case came back 409 — the pricing guard correctly caught `split` moving. Fixed in
both `tax.ts` and `billing.ts`'s pre-existing `updateTaxRuleDefaultRequest`, where
the same bug changes what every clinic in a country charges.

⚠️ **THE RATE CARD CANNOT BE BUILT ON `GET /tax/rules`, AND A SCREEN THAT WAS
WOULD SHOW AN EMPTY PAGE TO A FULLY CONFIGURED CLINIC.** rcln maintains a
catalogue per country which the engine READS at pricing time rather than copying at
signup, so a clinic with no rules of its own is configured, not unconfigured.
`GET /tax/rate-card` answers from both tables, per category, and reports which —
plus what a `TENANT` category displaced, because "we charge 18% where rcln says
exempt" is the one sentence this screen exists to produce.

⚠️ **AND IT ASKS `rulesFor` RATHER THAN DECIDING PRECEDENCE ITSELF.** All-or-nothing
per category, region-versus-country, stacking and overlapping date ranges are all
in `@rcln/tax`. A second copy in a service is how a screen starts telling a clinic
it charges something the invoice does not.

⚠️ **ENDING A RULE FALLS BACK TO THE CATALOGUE ONLY WHERE THE CATALOGUE COVERS THE
CATEGORY, AND FOR GOODS IT DELIBERATELY DOES NOT.** The first version of the
service comment and the first test both assumed the fallback was universal. rcln
publishes healthcare SERVICES; a medicine's rate depends on the medicine, so
ending a `MEDICINE` override leaves the category UNRATED and unissuable. Both
outcomes are now asserted, because assuming the first is how a clinic ends a
medicine rate and finds out at the counter.

⚠️ **A RULE THAT PRICED AN ISSUED INVOICE CANNOT HAVE ITS RATE MOVED, AND THAT IS A
409 RATHER THAN A DATABASE TRIGGER.** The invoice's totals are frozen at the
database, so rewriting the rule leaves a correct document with an explanation that
no longer matches it — the worst of the available failures, because nothing looks
wrong. The description and the line names stay editable: they charged nothing, and
what an invoice PRINTS was snapshotted onto `invoice_taxes` at issue.

⚠️ **A REGISTRATION MAY BE EDITED IN PLACE AND A RULE MAY NOT, AND THE DIFFERENCE
IS THE SNAPSHOT.** `invoices.issuer_tax_id` and `.issuer_legal_name` are copied at
issue and never re-read, so correcting a mistyped GSTIN cannot rewrite a document
that has gone out. A rule has no such snapshot — `invoice_taxes` cites the row.

⚠️ **`coveredBranches` EXISTS BECAUSE THE COMMONEST TAX MISCONFIGURATION IS
SILENT.** A registration matches a branch's own `(country, region)`, so a
Karnataka GSTIN covers nothing if every branch is recorded in Maharashtra — and
the symptom is invoices issued with no tax and no error, because "this clinic holds
no registration here" is a legitimate answer the engine cannot tell apart from a
typo. The screen says which branches a registration covers, and says so in red
when the answer is none.

⚠️ **`billing.tax.*` AND NOT `settings.organization.*`, AND READ IS SEPARATE FROM
MANAGE.** A setting is a preference and the worst a bad one does is annoy somebody;
a tax rule decides what every patient is charged and what the clinic owes. The
accountant and the two "everything except" roles manage it; BRANCH_ADMIN reads it,
because the rate card explains a bill their counter raised and a rate is an
organization-wide legal position. Pinned by a purpose-built `TAX_LOOKUP` role
holding exactly the read — no seeded role is shaped that way, so the seeded ones
would not have exercised the split.

⚠️ **`due_date` IS SLICED AND `supplied_at` IS CONVERTED, AND SWAPPING THEM
RE-DATES AN INVOICE ON A SAVE NOBODY MEANT.** `supplied_at` is a `timestamptz`
holding local midday in the branch's zone, so which day it falls on is a question
about a zone — hence `calendarDateIn`. `due_date` is a `DATE`, which Prisma returns
as UTC midnight and which has no zone at all: running it through the same helper
reports the previous day west of Greenwich and then saves that day back.

⚠️ **THE LEDGER STATES THE CLINIC'S ZONE AND THE DETAIL STATES THE BRANCH'S.** A
list can span branches in two zones and there is no single local midnight across
them, which is the same thing the API says about its own date filter. Quietly using
the first branch's zone would be a lie about the others.

⚠️ **THE INVOICE LIST RENDERS ITS ROWS ON NAVIGATION AND `/patients` STILL DOES
NOT, AND THE API AGREES WITH BOTH.** A patient list is a lookup and every read of
it is a disclosure; an invoice ledger is what a cashier reconciles the day from,
and `listInvoices` writes a `data_access_logs` row only when the caller asked about
one patient. Two screens, two reads, two answers.

⚠️ **`sendPaginated` PUTS THE COUNTS IN `meta`, AND EVERY OTHER LIST THIS APP
CONSUMES WRAPS ITS OWN ENVELOPE.** `GET /patients` answers `{ patients, total }` as
its `data`; `GET /v1/invoices` answers an array with `meta` beside it. A caller
reading only `data` gets the rows and a pager that always says page 1 of 1 —
`ApiPagination` in `lib/api.ts` is that difference written down.

⚠️ **"Invoices", NOT A SECOND TAB CALLED "Billing".** The existing Billing tab is
rcln billing the clinic. Two tabs with one name would be §0.1's confusion rendered
as navigation, and a clinic administrator holds both.

⚠️ **NO CLIENT-SIDE PRICING IN THE DRAFT EDITOR, AND THE ONE FIGURE IT DOES SHOW
SAYS WHAT IT IS.** Apportionment, largest-remainder rounding, per-currency
precision and the effective-dated rule all live in the engine; a second
implementation in the browser would be wrong in ways nobody notices until a return
is filed. The editor prints quantity × price beside each line, labelled "before
discount and tax", and every other number arrives from the server after a save.

⚠️ **THE CONFIRMATIONS ARE PANELS AND NOT MODALS.** A dialog that traps focus over
the document somebody is reading removes exactly the thing being confirmed. Issue,
cancel and void each state what will happen in plain terms, and the safe choice is
the one that dismisses the panel.

### Files changed

- `packages/contracts/src/tax.ts` — new; `index.ts`; `invoices.ts` —
  `cashRoundingMinor` removed from both request bodies; `billing.ts` —
  `updateTaxRuleDefaultRequest`'s defaults bug
- `packages/permissions/src/codes.ts` — `BILLING_TAX_READ`, `BILLING_TAX_MANAGE`;
  `roles.ts` — both to ACCOUNTANT, the read to BRANCH_ADMIN
- `packages/db/prisma/seed.ts` — `billing.cash_rounding_minor` (16 settings, 102
  permissions)
- `apps/api/src/services/tax/clinic-tax.service.ts` — new
- `apps/api/src/routes/v1/tax.routes.ts` — new, mounted in `index.ts`
- `apps/api/src/services/invoicing/pricing.service.ts` — resolves the rounding
  setting; `invoice-lifecycle.service.ts`, `appointment-billing.service.ts`,
  `invoices.routes.ts` — the parameter's plumbing removed
- `apps/api/src/routes/v1/invoices.routes.ts` — `GET /:invoiceId/preview`
- `apps/web/src/lib/api.ts` — `ApiPagination`, `apiBinary`, `apiHeaders`;
  `calendar-range.ts` — `calendarDateIn`; `invoice-filters.ts` — new
- `apps/web/src/app/(tenant)/t/[slug]/(app)/invoices/` — `page.tsx`, `actions.ts`,
  `[invoiceId]/page.tsx`, `[invoiceId]/pdf/route.ts`, `[invoiceId]/preview/route.ts`
- `apps/web/src/app/(tenant)/t/[slug]/(app)/taxes/` — `page.tsx`, `actions.ts`
- `apps/web/src/components/tenant/` — `invoice-list.tsx`, `invoice-detail.tsx`,
  `invoice-draft-editor.tsx`, `appointment-billing-panel.tsx`,
  `tax-rate-card.tsx` (all new); `invoice-document-frame.tsx` reshaped from
  `srcDoc` to `src`; `appointment-board.tsx` — the billing column;
  `tenant-header.tsx` — two nav entries
- `apps/web/src/app/(tenant)/t/[slug]/(app)/appointments/actions.ts` —
  `loadAppointmentBilling`, `raiseAppointmentInvoice`;
  `[appointmentId]/page.tsx` — the billing panel
- `apps/api/tests/integration/clinic-tax.test.ts` — new, 25 cases;
  `invoices.test.ts` — 2 cases for the preview

### Database changes

**No migration.** One `setting_definitions` row and two `permissions` rows, both
written by the seed — `db:rls:check` unchanged at 48. ⚠️ **Re-run the seed**: a
database that predates this phase has `billing.tax.read` missing rather than
wrong, and the symptom is an accountant who cannot open the tax screen.

The two tables this phase writes to for the first time — `issuer_tax_registrations`
and `tax_rules` — have had RLS policies and a `tenant-isolation.test.ts` block
since Phase 2, so no new isolation case was required. Verified rather than assumed.

### API changes

| Method | Path                        | Permission             |
| ------ | --------------------------- | ---------------------- |
| GET    | `/v1/invoices/:id/preview`  | `billing.invoice.read` |
| GET    | `/v1/tax/rate-card`         | `billing.tax.read`     |
| GET    | `/v1/tax/registrations`     | `billing.tax.read`     |
| POST   | `/v1/tax/registrations`     | `billing.tax.manage`   |
| PATCH  | `/v1/tax/registrations/:id` | `billing.tax.manage`   |
| GET    | `/v1/tax/rules`             | `billing.tax.read`     |
| POST   | `/v1/tax/rules`             | `billing.tax.manage`   |
| PATCH  | `/v1/tax/rules/:id`         | `billing.tax.manage`   |
| POST   | `/v1/tax/rules/:id/end`     | `billing.tax.manage`   |

⚠️ **BREAKING, AND DELIBERATELY:** `cashRoundingMinor` is no longer accepted on
`POST /v1/invoices`, `PUT /v1/invoices/:id` or
`POST /v1/appointments/:id/invoice`. It is `billing.cash_rounding_minor` at the
organization or the branch. Nothing in the product sent it.

### Tests added

`clinic-tax.test.ts` — 25 cases over real HTTP: a clinic starting with no
registration as a legitimate state, `coveredBranches` naming the branch and being
empty for a region no branch is in, the duplicate-registration 409, the inherited
card before the clinic writes anything, an override taking the whole category and
reporting what it displaced, the exempt-with-a-rate and country-wide-stacking
refusals, the same-day 409, a rule marked as used once an invoice is issued under
it, the 409 on moving its rate against the 200 on renaming it, the end date, the
fallback to the catalogue where there is one AND the drop to UNRATED where there is
not, read-without-manage refused at both write doors, and no `data_access_logs` row
for any of it. `invoices.test.ts` — the preview as `text/html` carrying the number
and the registration, with no `<script>` and the right headers, for an issued
invoice and for a draft.

### Known issues

- **`next build` fails on `/(marketing)/billing/sandbox`.** Unrelated to this
  phase — nothing in that page's module graph is Phase 9 code (it imports
  `useState`, `useSearchParams`, `Alert` and `Button`) — and it is a prerender
  error, `Cannot read properties of null (reading 'useContext')`. It was found
  because this phase is the first work to run a production build at all; the
  documented validation flow is typecheck, lint and tests. Worth its own
  investigation.
- **No screen for `/tax` rule EDITING.** The API has `PATCH /v1/tax/rules/:id`
  and the screen offers add and end only. Correcting a typo in a rule is
  therefore an API call — deliberate for one release, because the interesting
  question ("is this a correction or a rate change?") is exactly the one a form
  makes it easy to answer wrongly.
- **The rate card resolves one country, from `branches[0]`.** A clinic operating
  in two countries sees one card. The engine handles it per branch; this screen
  does not, and it should take the branch as a parameter when a tenant needs it.
- **`issuedOn` cannot be set from the screen.** A clinic entering yesterday's till
  can date the document through the API. Getting it wrong silently files an invoice
  into the wrong return period, which is why there is no control for it yet.
- **The ledger is offset-paginated**, as Phase 7 recorded. The `(createdAt, id)`
  ordering is already the keyset a cursor would use.
- **`AppError.code` still never reaches the client**, so `DOCUMENT_NOT_READY` is a
  409 the screen distinguishes by its message. Unchanged from Phase 7.
- **No polling for a PDF that is still rendering.** The Download control reads the
  document state from the page's own load, so a cashier who issues and downloads
  within the render window has to refresh. A poll is cheap; a poll on a PHI surface
  needs a decision about `data_access_logs` first.
- **No payments, so `amount_paid` is always zero.** The Outstanding column is
  therefore always the grand total, and "Settled" is unreachable through any route.
- **The tax screen has no history view for registrations**, only for rules. A
  lapsed registration is visible with its dates and cannot be filtered for.

### Next phase

**Phase 10 — audit.** The invoice surface writes `audit_logs` rows for its writes
and `data_access_logs` rows for its reads already; what is missing is the SCREEN
that reads them back for an invoice, and the sweep that proves no allow-list
snapshot on this phase's new entity types (`tax_rule`,
`issuer_tax_registration`) carries PHI. ⚠️ No PHI on an audit row; the allow-list
discipline from Stage 3 applies, and the tax entities are the easy case precisely
because a rate card names nobody.

---

## Phase 10 — Audit

**Complete.** **847 API tests** green (was 833) — 537 in the first split, 310 in
the second; **14 new** (11 in `invoice-audit.test.ts`, 2 in `audit-diff.test.ts`,
1 in `appointment-billing.test.ts`). 63 tax, 35 invoicing, 40 billing, 34 storage
package tests green; `db:rls:check` unchanged at **48** protected tables;
repo-wide typecheck and lint clean (35 of 36 turbo tasks, plus `apps/api`'s
`tsconfig.test.json` pass run separately for the documented OOM); api and worker
containers healthy.

⚠️ **THE PREMISE OF THIS PHASE AS WRITTEN AT THE END OF PHASE 9 WAS WRONG, AND
THE WORK WAS BIGGER THAN "A SCREEN".** That note said the invoice surface "writes
`audit_logs` rows for its writes and `data_access_logs` rows for its reads
already; what is missing is the SCREEN". Only the second half was true. **Not one
invoice write had ever written an audit row.** `services/invoicing/` imported
`recordDataAccess` and never `recordAudit`, so a bill could be opened, re-priced,
issued, cancelled and voided with nothing anywhere naming who did it — and
`invoices.test.ts` said so in prose at the top of the file ("a creation is a
write, and `audit_logs` has it") while asserting it nowhere. The screen was the
easy half; the trail it reads had to be written first.

### Completed

- **A row for every write in the life of an invoice** — create, edit, finalise,
  cancel, void — from one allow-list snapshot helper, threaded with the caller's
  IP and user agent from the routes that already collected them for the
  disclosure trail.
- **`AUDIT_SELECT` / `invoiceAuditSnapshot()`** — the first of CONVENTIONS.md's
  two layers, in one place: the columns that must never reach `audit_logs` are
  not selected at all.
- **Six keys added to `REDACTED_KEYS`** — the backstop under it, two of which the
  schema has been promising since Phase 3.
- **The history drawer on the invoice detail screen**, and on the tax rate card's
  registration and rule rows, which have written audit rows since Phase 9 with
  nothing reading them back.
- **Written field labels for the invoice and rate-card snapshots**, because the
  drawer's mechanical de-cameling renders `grandTotalMinor` as "grand total
  minor" beside an integer a reader will take for rupees.
- **The PHI sweep**, across every entity type the suite touches rather than only
  the one it is about.

### Decisions worth knowing about

⚠️ **THE SNAPSHOT IS READ FROM THE ROW ON BOTH SIDES OF THE WRITE, NEVER BUILT
FROM THE REQUEST.** The interesting half of an invoice is DERIVED: the cashier
types a quantity and a price, and what moves is the tax, the apportioned discount
and the grand total. A snapshot assembled from the request body would record what
was asked for and miss what the engine did with it — and would then be silent
about finalisation's re-price, which is the one change on this surface that no
human makes. A rate card corrected between a draft being opened and the patient
being handed the bill moves the tax on a request whose body was empty; that is
now the `before`/`after` on the issue row, and it has a test.

⚠️ **AND THE CREATE'S SNAPSHOT IS TAKEN AFTER THE PRICING, NOT AFTER THE INSERT.**
The row exists between the two with every money column at its `@default(0)`. A
snapshot taken there would file a ₹1,120 invoice as costing nothing —
permanently, into a table that is deliberately protected against correction. This
is the same bug Phase 3 shipped to the screen, and it is worse here, because a
screen showing zero gets noticed within a day.

⚠️ **`lineCount`, NOT THE LINES.** `invoice_items.description` is "Ultrasound,
obstetric" — a diagnosis in a billing column, and the field a clinic types the
most identifying thing on an invoice into after the customer's name. "The bill
went from three lines to five" is the audit question; what the two extra lines
were for is on the invoice, behind `billing.invoice.read` and a
`data_access_logs` row.

⚠️ **`hasNotes` AND `hasCancellationReason`, AND THE SCHEMA HAS SAID SO SINCE
PHASE 3 WITHOUT IT BEING TRUE.** `invoices.notes` carries the comment "PHI-CAPABLE
FREE TEXT, printed on the invoice. In `REDACTED_KEYS`" and
`cancellation_reason` says "same PHI treatment as notes". Neither was in
`REDACTED_KEYS`. Both are now, and the snapshot reports them as booleans instead
— "Reason recorded: no → yes" is the auditable fact, and the sentence stays on
the invoice where a reader who may see the bill can read it. A doc comment
asserting an invariant that the code does not implement is worse than no comment:
the next person reads it as a guarantee.

⚠️ **THE FOUR CUSTOMER COLUMNS ARE IN THE DENY-LIST TOO, AND THEY DO NOT
CONTRADICT THE `email`/`phone` PARAGRAPH ABOVE THEM — THEY ARE WHY IT IS WORDED
THAT WAY.** That paragraph refuses to blanket-redact `email`, because
`invitations` records the invited address on purpose and `branches` records a
public switchboard number. `customerEmail` is a different key on one table, and
the only entity in this system carrying it is a bill raised to a patient. The
price is a B2B invoice's contact details, which nothing in the trail needs.

⚠️ **THE GATE IS `audit.record.read` AND `billing.invoice.read` DOES NOT IMPLY
IT, WHICH LOOKS LIKE AN OVERSIGHT AND IS THE §0.7 RULE HOLDING.** The obvious
widening is an entry in `HISTORY_ALSO_READABLE_BY` — whoever may read the bill may
read its trail — and it is wrong here in a way it is not for
`appointment_vital`. The audit endpoint keys on `(entityType, entityId)` and
knows nothing about an invoice's SOURCE, so that entry would hand a receptionist
the trail of a LAB invoice the ledger correctly hides from them, and `loadVisible`
answers 404 rather than 403 precisely so they cannot learn the id is a lab
invoice at all. Widening it properly means resolving invoice visibility inside
the audit route, which couples the audit router to the invoicing service for a
convenience nobody has asked for. ACCOUNTANT holds `audit.record.read` and is who
reconciles a ledger; the drawer is not rendered for anyone else.

⚠️ **FINALIZING IS NOT IN THE TRAIL.** Finalisation is two updates so the frozen
columns land while the row is still DRAFT, and the state between them is the
shape of the write rather than a row anybody observes — the lifecycle file's
header says so. One audit row covers the transition. Three rows for one issue
would file a state no reader can ever be shown the invoice in.

⚠️ **A VOID'S TWO SNAPSHOTS ARE IDENTICAL ON EVERY FIGURE, AND THAT IS THE
POINT.** A void reverses a document without changing a number on it, so
`diffSnapshots` narrows the row to the status, the void date and the reason
having been recorded. The consequence is that "the totals did not move" becomes
provable FROM the trail rather than assumed about it, because a row that had
moved them would say so.

⚠️ **MONEY IS AN INTEGER COUNT OF MINOR UNITS ON THE ROW, AND THE DRAWER SAYS SO
RATHER THAN PRETENDING TO FORMAT IT.** `numeric(14,2)` through a float on its way
into JSONB is where a ledger loses a paisa, so the snapshot goes through
`money.ts` — the one boundary — and the keys carry a `Minor` suffix. The drawer
cannot render `₹1,120.00` honestly, because a diff holds only what MOVED and the
currency is usually not in it; it labels the field "Grand total (smallest unit)"
instead. An amount rendered in the wrong unit with no warning is worse than a
clumsy label.

⚠️ **ONE ROW FOR THE APPOINTMENT DOOR, WRITTEN BY `createDraftInvoice`.** The
appointment-billing path differs from the generic one in what it READS — the rate
card, the visit's day — and not at all in what it writes. `sourceType` and
`appointmentId` on the snapshot are what make the two distinguishable in the
trail; a second `recordAudit` in that service would file one creation twice.

⚠️ **`repriceDraftInvoice` DELIBERATELY WRITES NO ROW.** It re-prices from the
stored inputs and changes nothing a person typed. It has no caller outside the
tests and inside finalisation, which audits its own re-price through the
before/after pair. Giving it a row of its own would put an entry in the trail for
an act nobody performed.

⚠️ **THE SWEEP EXPECTS ONE HIT, AND THE HIT IS THE FINDING.** A `tax_rule`'s
`description` is free text a clinic writes about its own rate card, and
`clinic-tax.service.ts` records it verbatim — correctly, because who renamed a
rate is the question that trail exists to answer. Typing a patient's name into it
puts that name on an audit row, and no allow-list can prevent a user doing that
to a field whose contents ARE the record. Asserted rather than "fixed": the fix
would be a rate-card trail that cannot say what changed. Every other needle — the
customer block, the phone, the address, the line description, the void reason —
must be absent, and the same query scoped to `invoice` and
`issuer_tax_registration` expects zero.

### Files changed

- `apps/api/src/services/audit/audit.service.ts` — six keys added to
  `REDACTED_KEYS`: the four `customer*` columns, `notes`, `cancellationReason`
- `apps/api/src/services/invoicing/invoice-lifecycle.service.ts` —
  `InvoiceAuditOptions`, `AUDIT_SELECT`, `invoiceAuditSnapshot()`, and a
  `recordAudit` call in each of the five writes
- `apps/api/src/services/invoicing/invoice.service.ts` — `auditOptions()`, the
  narrowing from `InvoiceActionOptions`, threaded into all four write paths
- `apps/api/src/services/invoicing/issue-invoice.ts`,
  `appointment-billing.service.ts` — the same options carried through
- `apps/web/src/components/tenant/invoice-detail.tsx` — `canReadHistory` and the
  drawer; `tax-rate-card.tsx` — the same on registration and rule rows;
  `record-history.tsx` — 21 written field labels
- `apps/web/src/app/(tenant)/t/[slug]/(app)/invoices/[invoiceId]/page.tsx`,
  `taxes/page.tsx` — `PERMISSIONS.AUDIT_READ` passed down
- `apps/api/tests/integration/invoice-audit.test.ts` — new, 11 cases;
  `appointment-billing.test.ts` — 1 case; `tests/unit/audit-diff.test.ts` —
  2 cases

### Database changes

**No migration, no new permission code and no seed row.** `audit_logs` has
carried every column this phase writes since the platform's first migration, and
the gate is `audit.record.read`, which has existed as long. `db:rls:check`
unchanged at 48. A database current for Phase 9 is current for Phase 10 — the
first phase since Phase 4 for which that is true with no caveat at all.

### API changes

**None.** No route was added, altered or re-gated. `GET /v1/audit` answers for
`entityType=invoice` because it always would have — there was simply nothing to
return.

### Tests added

`invoice-audit.test.ts` — 11 cases over real HTTP: the CREATE row carrying the
PRICED totals rather than the zeroes the row was inserted with, that same row
naming nobody, an edit narrowing to what moved and not restating the branch or
the currency, the issue row carrying the number and the registration as ONE row
rather than three, the re-price surfacing when the rate card moved under the
draft, a cancelled draft, a void that restates no figure on the document, the
whole trail read back through `GET /v1/audit` with the actor's name joined on the
way out, the desk cashier's 403, the sweep, and no `data_access_logs` row for
reading a trail. `appointment-billing.test.ts` — exactly one row for the
appointment door, citing the visit and naming nobody, which is the sharpest place
in the repo to check the customer block since that customer IS a real patient
record. `audit-diff.test.ts` — the deny-list firing on the customer block and on
the two free-text columns, tested there because nothing in the product can reach
it: `invoiceAuditSnapshot()` never selects those columns, and a backstop nobody
has seen fire is a backstop that quietly stopped containing the key.

### Known issues

- **`next build` still fails on `/(marketing)/billing/sandbox`.** Unchanged from
  Phase 9, same page, same `Cannot read properties of null (reading 'useContext')`
  prerender error, and nothing in that page's module graph is Phase 10 code. Run
  and confirmed identical rather than assumed.
- **A `tax_rule`'s `description` is verbatim on its audit row**, as the sweep
  asserts. It is the only free-text field this repository's audit trail records
  unredacted, and it is a clinic's note about its own rate card. If it ever needs
  to change, the fix is a rate-card trail that names the field without quoting it
  — not a deny-list entry, which would blank the one thing that trail says.
- **The invoice history drawer is `audit.record.read` only.** A cashier who
  raised a bill cannot see who edited it. The narrower widening — this caller,
  this source set — needs the audit route to resolve invoice visibility, and that
  is a coupling worth making only when a clinic asks.
- **The trail records no PAYMENT**, because there are none. `amount_paid` is
  always zero, so no `PARTIALLY_PAID` or `PAID` transition has ever occurred and
  the snapshot has no `amountPaidMinor` key. Add it with the payments table, not
  before — an allow-list entry for a column nothing writes is an entry nobody
  will re-examine when something does.
- **The drawer's money labels say "smallest unit", not "₹".** Correct and
  clumsy. The fix is for `readHistory` to return the invoice's currency beside
  the entries, which means the audit service knowing what an invoice is.
- **No history on `invoice_items`.** A line is not an entity with a life — a
  re-price deletes and rewrites every row, by design (see `priceAndPersist`) — so
  the invoice's own trail is where a line change is visible, as `lineCount` and
  the totals that moved.
- **`AuditAction` has no `ISSUE`, `CANCEL` or `VOID`**, so all four transitions
  are `UPDATE` and the drawer says "Changed" over each. The status on the row
  says which. A verb per transition is an enum change and a migration for
  something the diff already states.

### Next phase

**Phase 11 — S3 provider and final QA.** `providers/s3.ts` behind the interface
Phase 1 built, the queued PDF generation the local provider has been standing in
for, and the end-to-end pass over the whole engine. It is also where the
`next build` failure on `/(marketing)/billing/sandbox` should finally be run to
ground: it has been carried as a known issue since Phase 9 and it is the one
thing in this engine's neighbourhood that no green check covers.
