# Tax registrations, coverage and where tax meets billing — implementation log

Who the clinic is registered as, which of its places bill under which
registration, and how any module that sells something gets its lines taxed
correctly in any country.

Living document. Read this before touching `issuer_tax_registrations`,
`tax_rules`, branch jurisdiction, or before wiring a new billable module
(pharmacy, lab, inventory) into invoicing.

- **Branch:** `feat/phase-3-clinical-core`
- **Started:** 2026-08-11
- **Status:** **Shipped and validated.** Coverage, history, de-duplication and
  branch jurisdiction are complete end to end. Pharmacy and lab are not built;
  §6 is the plan for them and §7 the decisions still open.
- **Read first:** [`invoice-engine-implementation.md`](invoice-engine-implementation.md)
  §0.1, for why there are two tax tables and why they must never merge.

---

## 0. The mental model, in one page

Four concepts, deliberately separate. Conflating any two of them is the failure
this whole area is shaped to prevent.

| Concept              | Table                              | Answers                                                        |
| -------------------- | ---------------------------------- | -------------------------------------------------------------- |
| **Organization**     | `organizations`                    | Who the business is. The tenant.                               |
| **Branch**           | `branches`                         | Where it operates. A place, never a registration.              |
| **Tax registration** | `issuer_tax_registrations`         | What it is registered as, where, under which scheme, and when. |
| **Coverage**         | `issuer_tax_registration_branches` | Which places bill under which registration.                    |
| **Rate**             | `tax_rules` + `tax_rule_defaults`  | What one KIND OF THING is taxed at, here, on this date.        |

Two independent questions are answered on every invoice, and keeping them apart
is the point:

```
WHICH NUMBER, WHOSE RETURN?          AT WHAT RATE, EXEMPT OR NOT?
  branch → coverage → registration      line's taxCategory → rule
  asked ONCE per invoice                asked PER LINE
  varies by BRANCH                      varies by ITEM
```

A Bihar bill mixing an exempt consultation with 12% medicine resolves **one
registration** and **two rates**. Neither question can answer the other.

### The five facts that must stay true

1. **An organization holds zero, one or many registrations**, and the count has
   nothing to do with how many branches it has. Zero is a clinic below the
   registration threshold — a legitimate steady state, not an unfinished setup.
2. **A branch is not a registration.** Three branches do not imply three
   registrations, and one registration may cover all of them.
3. **Coverage is a statement, not a derivation.** See §2.
4. **History survives.** A lapsed registration is kept beside the one that
   replaced it, in the same jurisdiction, because an invoice raised today for
   last year's supply must cite the number in force then.
5. **Nothing is GST-specific.** Scheme, jurisdiction and rate are data. The
   engine never branches on a country.

---

## 1. What exists

### Database

| Table                                    | Notes                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer_tax_registrations`               | The clinic's own registrations. RLS `tenant_isolation`. Unique on **(org, country, scheme, registration_number)** — the NUMBER, not the jurisdiction.                                                                     |
| `issuer_tax_registration_branches`       | Coverage links. RLS + composite FKs to both parents, so a link can never join one tenant's branch to another's registration.                                                                                              |
| `tax_rules`                              | The clinic's own rates, per category, effective-dated. RLS.                                                                                                                                                               |
| `tax_rule_defaults`                      | rcln's published catalogue per country. **RLS-exempt on purpose** — a policy would return zero rows inside a tenant transaction and no invoice on the platform could be priced.                                           |
| `tax_registrations`                      | ⚠️ **rcln's own** registrations, for billing clinics for their subscription. Not the clinic's. Never merge with the above.                                                                                                |
| `branches.country_code` / `.region_code` | The branch's tax jurisdiction. Distinct from `branches.state`, which is free text for an address label.                                                                                                                   |
| `branches.tax_id`                        | **Dead.** Retained so old data is recoverable; no read or write path.                                                                                                                                                     |
| `organizations.tax_id`                   | **Derived, not typed.** A cache of the registration that currently applies, maintained by `syncOrganizationTaxIdentity`. Still exists because the subscription side needs one number for the clinic _as rcln's customer_. |

Migration: `20260813090000_tax_registration_branch_coverage`. It backfills
coverage from the jurisdiction matching that was in force before it, so no
clinic's behaviour moved on deploy.

### Code

| Area                                                            | Where                                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pure engine — selection, rates, splits, stacking                | `packages/tax/src/{selection,engine,types,arithmetic}.ts`. Holds no Prisma client and reads no database. |
| Country data — schemes, regions, tax-id formats, postal formats | `packages/contracts/src/locale.ts`                                                                       |
| Contracts                                                       | `packages/contracts/src/tax.ts`, `tenancy.ts`                                                            |
| Registration + rate CRUD, coverage, org tax sync                | `apps/api/src/services/tax/clinic-tax.service.ts`                                                        |
| Loading the tax position for an invoice                         | `apps/api/src/services/invoicing/tax.service.ts` → `loadTaxContext`                                      |
| Pricing a draft                                                 | `apps/api/src/services/invoicing/pricing.service.ts`                                                     |
| Refusing to issue an uncovered bill                             | `apps/api/src/services/invoicing/invoice-lifecycle.service.ts` → `assertRegistrationCoversBranch`        |
| Branch jurisdiction + validation                                | `apps/api/src/services/branch/branch.service.ts` → `assertJurisdiction`                                  |
| First registration at signup                                    | `apps/api/src/services/organization/register.service.ts`                                                 |
| Routes                                                          | `apps/api/src/routes/v1/tax.routes.ts`                                                                   |
| Screens                                                         | `apps/web/src/components/tenant/{tax-rate-card,clinic-settings,branch-list}.tsx`                         |
| The printed document — shell                                    | `packages/documents/src/invoice/document.tsx`                                                            |
| The printed document — item table per source                    | `packages/documents/src/invoice/items.tsx` (`ITEM_TABLES`)                                               |

### Endpoints

All behind `requireTenant → authenticate → requireAuth → authorize → validate`.

| Method | Path                                     | Permission           |
| ------ | ---------------------------------------- | -------------------- |
| GET    | `/api/v1/tax/rate-card`                  | `billing.tax.read`   |
| GET    | `/api/v1/tax/registrations`              | `billing.tax.read`   |
| POST   | `/api/v1/tax/registrations`              | `billing.tax.manage` |
| PATCH  | `/api/v1/tax/registrations/:id`          | `billing.tax.manage` |
| PUT    | `/api/v1/tax/registrations/:id/branches` | `billing.tax.manage` |
| GET    | `/api/v1/tax/rules`                      | `billing.tax.read`   |
| POST   | `/api/v1/tax/rules`                      | `billing.tax.manage` |
| POST   | `/api/v1/tax/rules/:id/end`              | `billing.tax.manage` |

There is **no DELETE on either resource**, deliberately. A registration lapsing
is `effectiveTo` through the PATCH; a rate ending is `POST /rules/:id/end`.
`deletedAt` exists for a row created in error and is unreachable from the API.

---

## 2. Coverage: the central decision

**Which branches a registration covers is stated by the clinic and never
inferred from an address.**

Before this, coverage was computed by matching a branch's `(country, region)`
against the registration's. That answered "which branches does this GSTIN
cover?" with _whichever ones happen to sit in the same state_, which forbids
three shapes the business genuinely has:

- two branches in one state billing under two different numbers (India has
  permitted a second GSTIN per state for a separate vertical since 2019);
- one number deliberately covering only some of the branches in its state;
- any arrangement in a country whose registrations are not drawn on state lines.

### The two rules, which must stay identical in three places

```
A registration WITH links   → covers exactly those branches. Not "those plus
                              any in the same state".
A registration WITHOUT links → covers branches that have stated nothing AND
                              whose place of supply matches.
```

They are implemented in:

1. `clinic-tax.service.ts` → `toRegistrationSummary` (what the screen shows)
2. `invoicing/tax.service.ts` → `loadTaxContext` (what the engine may price against)
3. `tax-rate-card.tsx` → `CoverageEditor` (what the editor offers)

If they drift, the screen describes a selection the invoice does not make.

### Why the fallback exists

So the change was additive. A clinic that never opens the coverage screen bills
exactly as it did before, and a **newly opened branch still picks up its state's
registration automatically** — because it has stated nothing. Adding a branch to
a configured clinic does not silently stop it charging tax.

### One live registration per (branch, scheme)

Enforced in `setClinicTaxRegistrationBranches`, not in Postgres — "live" is an
overlap between two date ranges across a join, which needs an exclusion
constraint this schema does not have. Two live GSTINs on one branch is not a
richer configuration; it is an invoice whose number depends on planner order.

Consequence: **moving a branch between registrations is two operations** —
release it from the first, then assign it to the second. The refusal is
deliberate; ticking a branch on registration B silently pulling it off
registration A would mutate a record the user is not looking at and file an audit
row they did not ask for.

---

## 3. Selection, end to end

```
invoice draft at branch X, supplied on D
  │
  ├─ loadTaxContext(branchId = X, at = D)
  │    ├─ branch row → placeOfSupply { countryCode, regionCode }
  │    ├─ live registrations (effectiveFrom ≤ D ≤ effectiveTo)
  │    ├─ coverage links for X
  │    │     links exist → narrow to those registrations
  │    │     no links    → narrow to those whose jurisdiction matches X   ← strict
  │    ├─ tenant tax_rules
  │    └─ platform tax_rule_defaults for the branch's country
  │
  ├─ per line: resolveTax(net, taxCategory, placeOfSupply)
  │    ├─ registrationFor(...)      → which number
  │    ├─ rulesFor(...)             → which rate(s); TENANT beats PLATFORM,
  │    │                              all-or-nothing per category
  │    └─ split / stack             → the printed lines
  │
  └─ snapshot onto the invoice: issuer_tax_id, issuer_legal_name,
     issuer_tax_registration_id, place of supply, and per-line invoice_taxes
     citing the rule that priced them
```

⚠️ **The fallback narrowing is strict, and that is a behaviour change from
Phase 2.** `registrationFor` ends in `?? inCountry[0]` — a last-resort guess.
With every live registration in scope, a clinic registered only in Karnataka
billed its Maharashtra branch under the Karnataka GSTIN: plausible invoice, tax
filed against the wrong registration, and the coverage screen saying "covers
nothing" while the engine billed under it anyway. The guess is still wanted for
_stated_ coverage, where a clinic has deliberately put an out-of-state branch
under a registration and means it. It must not be invented from an address.

A branch nothing covers prices `NOT_REGISTERED`, and
`assertRegistrationCoversBranch` refuses to issue **only if the clinic holds a
live registration elsewhere in that country**. Holding none anywhere is a
practice below the threshold and issues normally.

---

## 4. Rates, exemptions and country neutrality

Rate is a property of the **item**, never of the registration. A clinic sells a
consultation (exempt in India), medicines (5% or 12%) and consumables (12% or
18%) under one GSTIN. `issuer_tax_registrations` deliberately has no rate column.

- **`taxCategory` on an invoice line is the only join between a selling module
  and tax.** An HSN/SAC code, or a clinic's own name. Compared exactly.
- **Tenant rules beat platform defaults, all-or-nothing per category.** Writing
  one rule for a category takes the whole category out of the inherited set.
- **A category with no rule is `UNRATED`** — zero charged, the reason on the
  document, and finalisation refusing to issue. Never the registration's
  standard rate, which would produce a plausible invoice at a rate nobody chose.
- **Rate changes are new rows**, never edits. The API refuses to move a rate that
  priced an issued invoice.

### How the country variation is expressed

Nothing branches on a country. It is all data on the rule:

| Shape                   | Mechanism                           | Example                                    |
| ----------------------- | ----------------------------------- | ------------------------------------------ |
| One rate, one line      | `split: NONE`                       | Ireland, UK VAT                            |
| Constitutional halves   | `split: INTRA_STATE_HALVES`         | India CGST + SGST; IGST when inter-state   |
| Two taxes stacking      | `stacks: true` on the regional rule | British Columbia GST + PST                 |
| Untaxed, credit differs | `EXEMPT` vs `ZERO_RATED`            | India exempts; Australia and UAE zero-rate |
| Too complex to compute  | `PROVIDER_REQUIRED`                 | US sales tax, deliberately not attempted   |

Intra vs inter-state is decided by comparing the **registration's region** to the
**place of supply**, in `engine.ts`. The halves are computed so they sum to the
total rather than rounding independently.

### The seeded catalogue, and what it does not cover

`tax_rule_defaults` is seeded for `CONSULTATION`, `PROCEDURE` and `LAB_TEST` in
IN / GB / IE / AU / AE — all exempt or zero-rated. **Goods are deliberately
unseeded.** The first `MEDICINE` line therefore comes back `UNRATED` and cannot
be issued until the clinic enters a rate it has checked. Guessing 12% for every
clinic in India would be rcln giving tax advice.

`unratedCategories` on the rate card lists exactly the categories appearing on
open drafts with no rule anywhere, so the clinic finds out before the counter
does.

---

## 5. De-duplication: one authoritative record

The clinic's tax number used to exist in three places. Now:

| Was                                                  | Now                                                                                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizations.tax_id`, typed on the settings screen | Derived by `syncOrganizationTaxIdentity` from the registration that applies. Not in the organization PATCH contract. Settings shows a read-only reference list linking to `/taxes`. |
| `branches.tax_id`, writable and meaningless          | Removed from contracts and services. Column retained, documented dead.                                                                                                              |
| `issuer_tax_registrations`                           | Unchanged — the authoritative record.                                                                                                                                               |

Three names remain three fields, because they are three concepts even when they
read alike: `organizations.legal_name` (how the company is constituted),
`organizations.display_name` (what a patient sees), and a registration's
`legal_name` (the name THAT REGISTRATION is held in, which a tax invoice must
print verbatim). A registration with no name of its own falls back to the
organization's at document render time.

---

## 6. Wiring a new billable module (pharmacy, lab, inventory)

None of these exist yet. What follows is the plan and the constraints already
in place.

### What already supports them

- **`InvoiceSourceType`** already has `LAB`, `PHARMACY`, `INVENTORY`, `PROCEDURE`,
  `SERVICE`, `OTHER`.
- **Numbering is already per source.** The sequence keys on
  `{period}:{sourceCode}` per branch, so each source gets its own series:
  `INV-2026-APP-MAIN-000001`, `INV-2026-PHA-MAIN-000001`,
  `INV-2026-LAB-MAIN-000001`.
- **`invoices.appointment_id` is nullable and indexed, not unique.** Several
  invoices may cite one appointment — the appointment id is the thread through
  the visit, not a one-to-one key.
- **Tax needs nothing new.** A module produces lines; `taxCategory` does the rest.

### ⚠️ The appointment invoice bills the VISIT, not the booking

Worth stating plainly, because the opposite is the natural assumption. There is
no invoice at booking. `POST /appointments/:appointmentId/invoice` is a
deliberate act by whoever bills, and:

- it is **blocked for `CANCELLED` and `NO_SHOW`** — a no-show fee is a different
  charge, raised manually through `POST /invoices`;
- the **supply date is the day of the visit**, read in the branch's zone, so a
  bill raised late is still taxed as the visit's date;
- booking itself writes nothing to `invoices`.

Moving to pay-at-booking is a product decision with a tax consequence, not a
refactor: money taken to hold a slot is an **advance**, which under Indian GST
has its own treatment for services, and a cancellation then needs a refund or
credit note rather than simply never being billed.

### What the appointment invoice prints

Beyond the shared structure, a consultation bill carries **who provided the
care** — `invoices.practitioner_name` and `.practitioner_registration_number`,
snapshotted at billing time from the appointment's doctor.

⚠️ **Snapshotted, never joined through `appointment_id`.** A clinician who
leaves, marries or re-registers must not restate a document already handed to a
patient — the same rule as the customer block and the issuer's tax number. Null
on every source that does not bill attendance; a pharmacy dispense has a
_prescriber_, which is a different fact and earns its own column when that
module exists.

### One document shell, one item table per source

⚠️ **The line-item table is the only part of an invoice that varies by what was
sold, and it is the only part that may vary.** `packages/documents/src/invoice/items.tsx`
holds a registry keyed on `sourceType`; `document.tsx` renders everything else
exactly once.

```
InvoiceDocument                     ← masthead, GSTIN + its country-correct label,
  │                                   place of supply, tax summary, totals,
  │                                   TAX INVOICE vs BILL OF SUPPLY, closing
  └── ITEM_TABLES[sourceType]
        ├── AppointmentItems   # · Description · Fee · Discount · Taxable · Tax · Amount
        └── DefaultItems       # · Description · HSN/SAC · Qty · Rate · … (everything else)
```

**Why not four templates.** Only the item table differs; the rest is what an
auditor reads and a return is filed from. Four copies give those four homes, and
the failure is quiet — someone corrects the CGST/SGST grouping on the pharmacy
document, nobody touches the lab one, and for months lab invoices file a tax that
does not reconcile while every total on the page still adds up. Same reasoning as
the `InvoiceDocumentData` header: one function, one value, no second path.

**Why a registry and not `showQty` flags.** Conditional columns was the first
shape of this and it does not survive the second module — flags multiply, every
table pays for every other table's columns, and the fixed widths stop adding up.
`ITEM_TABLES` is an exhaustive `Record` over `InvoiceDocumentSourceType`, so a new
source is a compile error rather than a silent fall-through.

**What the appointment table drops, and why.** No Qty — a consultation is one of
one, and a column of `1.000` is noise on the document a patient actually reads.
No HSN/SAC — nothing classifies a service yet, so it would print a row of dashes.
Both return the moment there is something to put in them, as columns rather than
flags. Its description column is `.col-desc-wide` (79mm), absorbing the 25mm the
two dropped columns take, so both tables total 182mm and the money columns land
in the same place on the page.

The money column reads **Fee** on an appointment and **Rate** elsewhere — a
consultation is charged a fee, a dispense has a unit rate. That is the only thing
`InvoiceDocumentData.sourceType` exists for.

**Adding `PharmacyItems` / `LabItems`:** write the component beside the others,
register it, done — do not grow `DefaultItems` with columns one source uses.
⚠️ Pharmacy needs **batch and expiry per line**, which are part of the sale record
for prescription medicines and are what a recall or a return is traced through.
`invoice_items` has no column for either, so that is a schema change as well as a
table. `INVOICE_TEMPLATE_VERSION` is bumped on any change a reader would notice;
it is **2** as of this split.

### The intended flow

```
appointment apt0001
  └─ consultation → prescription (clinical intent)
       ├─ pharmacy: look up apt0001 → dispense → invoice (PHARMACY)
       └─ lab:      look up apt0001 → book     → invoice (LAB)
```

The patient may take the prescription to a third party, in which case no invoice
exists here at all. That is why the invoices are independent rather than one
bill per visit.

### ⚠️ The collision waiting for pharmacy

`appointment-billing.service.ts` refuses a second bill for a visit, and the
check is **not scoped to source type**:

```ts
const live = await tx.invoice.findFirst({
  where: { appointmentId, deletedAt: null, status: { in: LIVE_STATUSES } },
});
```

Correct today, because APPOINTMENT is the only source that exists. The moment a
pharmacy invoice cites `apt0001`, this fires on the consultation bill and in the
other direction too. The fix is adding `sourceType: 'APPOINTMENT'` to the
`where`, which encodes the real rule: **one consultation charge per visit, any
number of dispenses and tests against it.** Make that change _with_ the pharmacy
module, so the guard is never looser than the modules that exist.

### What each module owes

1. **A `taxCategory` on its catalogue row.** Paracetamol and a glucometer are
   taxed differently, so it cannot be a constant the way `CONSULTATION` is in
   `appointment-billing.service.ts`.
2. **Lines built from what happened, not what was intended.** The prescription
   is clinical intent; the pharmacist substitutes a generic, dispenses 10 of 15,
   or the patient declines one. Billing straight off prescription lines invoices
   medicine that never left the shelf. Same for the lab: the prescription
   suggests a CBC, the invoice bills the booked test.
3. **Nothing else.** Registration selection, rate resolution, exemptions, splits,
   stacking, effective dating and the refusal to issue an unrated bill all come
   for free.

### Not built at all

There is **no `Prescription` or `Encounter` model**. The permission codes are
reserved (`clinical.encounter.*`, `clinical.prescription.*`, DOCTOR-only by
invariant 7 in CLAUDE.md) but no schema, service or screen exists. That is the
hinge for both modules above.

---

## 7. Decisions still open

| #   | Question                                                                                 | Notes                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Category vocabulary** — HSN/SAC codes or own names?                                    | Compared as exact strings, so mixing conventions across modules fragments the rate card. Settle before pharmacy. Painful to unify later.                                                                                             |
| 2   | **Signup copies the registered name onto the registration.**                             | A hand-made registration leaves it blank and falls back; signup writes a copy that can drift from `organizations.legal_name`. One line in `register.service.ts`. Recommendation: drop it.                                            |
| 3   | **The Tax screen takes typed jurisdiction codes**, while the branch form uses dropdowns. | `IN` / `MH` free text, unvalidated against the subdivision list, so a typo produces a registration covering nothing. `COUNTRIES` and `regionsFor()` already drive the branch selects.                                                |
| 4   | **Registration numbers are not shape-checked** on `POST /tax/registrations`.             | `taxIdFormatFor` knows one format per COUNTRY; that endpoint records three schemes. A check per (country, scheme) is what would earn its place. Signup still checks.                                                                 |
| 5   | **Legacy `organizations.tax_id` with no registration behind it.**                        | Clinics onboarded before this work show a number in the column and no registration. Surface as "recorded, not a registration", or migrate in bulk? Not guessed on their behalf — a registration needs a scheme and a date.           |
| 6   | **Third-party dispense leaves no trace.**                                                | Does a prescription line stay open forever, or get marked dispensed-elsewhere? Clinical-safety question as much as a commercial one.                                                                                                 |
| 7   | **Pay-at-booking, or bill-the-visit?**                                                   | Today it bills the visit (see §6). Pay-at-booking makes the payment an advance, with its own GST treatment for services and a refund path on cancellation. Product decision, not a refactor.                                         |
| 8   | **Nothing populates `itemCode` yet.**                                                    | So the HSN/SAC column never renders. A consultation is SAC 9993 in India; medicines carry an HSN each. Ties to decision 1 — settle the vocabulary, then decide whether the code is stored per catalogue item or derived per country. |

---

## 8. Verifying a change here

```bash
docker compose exec api pnpm db:rls:check        # any schema change

docker compose exec -T -e NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=6144" \
  api sh -c 'cd apps/api && npx jest --runInBand tests/integration/<suite>.test.ts'
```

| Suite                       | Cases | Holds                                                                                                                                                                                                                                    |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tax-registration-coverage` | 26    | Zero/one/many registrations, one-to-many, many-to-one, the mixed split, active beside lapsed, a non-GST country — each asserted through `priceDraftInvoice`, because a coverage row the pricing path does not read is a screen that lies |
| `clinic-tax`                | 28    | Recording, correcting, lapsing, duplicate numbers, the rate card, read-vs-manage                                                                                                                                                         |
| `tenant-isolation`          | 188   | RLS and the composite FK on the coverage table                                                                                                                                                                                           |
| `invoicing-tax`             | 15    | What the engine is handed for a given branch                                                                                                                                                                                             |
| `invoice-lifecycle`         | 21    | Finalisation refusing a branch nothing covers                                                                                                                                                                                            |
| `invoice-pricing`           | 9     | Which registration id reaches the invoice                                                                                                                                                                                                |
| `settings`                  | 41    | The organization no longer accepting a tax number                                                                                                                                                                                        |

⚠️ **The API test run needs a raised heap** (`--max-old-space-size`); the
container's default OOMs partway through and reports a truncated summary.

⚠️ **`invoices.test.ts › finds a draft by date` fails between 18:30 and 24:00
UTC** — it compares a UTC "today" against a branch-local (Asia/Kolkata) day
range. Pre-existing and unrelated to this area.

---

## 9. What not to do

- Do not merge `tax_registrations` with `issuer_tax_registrations`. Different
  issuer, different authority, different return.
- Do not put a rate on a registration. A clinic sells several things at several
  rates under one number.
- Do not resolve an unrated category to the standard rate. `UNRATED` is the
  answer, and finalisation refuses it.
- Do not re-derive coverage anywhere. Three implementations already have to
  agree; a fourth will drift.
- Do not make `organizations.tax_id` writable again.
- Do not add a branch-level tax number. That is what coverage is for.
- Do not copy the invoice template per source. Add an item table to
  `ITEM_TABLES`; the shell stays single-source.
- Do not assume a region is required, or that a country has states at all.
