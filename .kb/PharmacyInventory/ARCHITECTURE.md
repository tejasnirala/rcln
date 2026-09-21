# Architecture & Decision Record

The decisions this programme is built on. Each has an id, a status, and the
reasoning. **Do not reverse one silently.** If a decision turns out to be wrong,
record the new position in [OPEN_DECISIONS.md](OPEN_DECISIONS.md), amend the
entry here with a `Superseded by` line, and note it in
[CHANGELOG.md](CHANGELOG.md).

These are `PI-ADR-nnn`, deliberately numbered separately from the repository's
own `.kb/Architecture/decisions/`. A `PI-ADR` that ends up constraining the
_whole_ system — not just this programme — gets **promoted** to a repository ADR
when the code lands. The promotion candidates are marked ⬆.

---

## PI-ADR-001 — Product is the root entity; Medicine is a facet ⬆

**Status:** Accepted

A medicine, a glove, an implant and a lab reagent are the same thing to
inventory: something with a quantity, a location, a cost and possibly a batch.
They differ in _attributes_ and in _regulation_, not in _storage_.

So `products` is the root, with a `ProductType` discriminator, and
medicine-specific attributes live in a `medicine_details` extension row keyed by
product — not in nullable columns on `products`, and not in a separate `medicines`
table that inventory would have to union with.

**Consequence:** every downstream domain (pharmacy, dental, lab, veterinary,
procedures) uses one inventory engine. Adding `PROSTHETIC` later is a new enum
member and possibly one extension table, not a new subsystem.

**Rejected:** `medicines` as root with a `consumables` sibling. It produces two
ledgers, two allocation engines and two sets of reports, and the second one is
always the neglected one.

---

## PI-ADR-002 — The regulatory engine ships before dispensing

**Status:** Accepted · Deviates from the brief's suggested phase order

Dispensing must consult the regulatory engine at four points (prescription
required, prescriber authority, quantity limit, substitution permitted). Those
calls determine the shape of the dispensing transaction. Building dispensing
first and inserting the engine afterwards means rewriting that transaction and
every test around it.

The slot is free anyway: dispensing is hard-blocked on `prescriptions`, which
Phase 3 owns and has not built.

See [MASTER_PLAN.md](MASTER_PLAN.md) § Deviation.

---

## PI-ADR-003 — The global catalogue is a platform master with tenant extension ⬆

**Status:** Accepted

`products`, `active_ingredients`, `compositions`, `manufacturers`,
`units_of_measure` and `product_categories` follow the **exact** pattern already
used by `specialties` / `qualifications` / `designations`:

- `organization_id NULL` = a platform row, readable by every tenant
- `organization_id = <org>` = that tenant's own row
- RLS: `USING (organization_id IS NULL OR organization_id = app_current_org())`,
  `WITH CHECK (organization_id = app_current_org())`

The asymmetry is the whole point and is already documented in
`enable-rls.sql`: a permissive `WITH CHECK` would let any clinic insert a
platform-wide row instantly visible to every other tenant — a cross-tenant write
dressed up as a catalogue entry.

⚠️ **Every join table that points at a possibly-platform row needs a
RESTRICTIVE `*_visible` policy**, exactly like `specialty_visible` on
`doctor_specialties`. Without it, a tenant can attach another tenant's private
product to its own row and read the name back out. This is the single most
likely security regression in PI-1.

**Inventory is never platform-scoped.** `batches`, `serials`, `stock_ledger`,
`stock_balances`, `inventory_locations` are strictly tenant rows with a
`NOT NULL organization_id`, and the branch-local ones carry `branch_id` and join
the `branch_scoped` RLS array too.

---

## PI-ADR-004 — The stock ledger is append-only and is the only source of truth ⬆

**Status:** Accepted

`stock_ledger` records every movement. `stock_balances` is a derived cache
maintained by a trigger, and is never read as authority for a correction — a
disagreement between the two is resolved by replaying the ledger.

Quantity is never mutated in place. There is no `UPDATE stock_balances SET
quantity = quantity - 1` anywhere in this programme.

Append-only is enforced the way `audit_logs` and `data_access_logs` already are
in this repository: `rcln_app` holds no UPDATE or DELETE on the table, _and_ a
trigger refuses. Two independent layers, both measured in a test.

**Consequence:** a correction is a compensating ledger entry with a reason, not
an edit. That is what makes traceability and recall possible at all.

**Rejected:** a `quantity` column on `batches` mutated transactionally. It is
faster and it is unauditable, and this is a PHI-adjacent regulated domain.

---

## PI-ADR-005 — Consumption is not a charge ⬆

**Status:** Accepted

Recording that two pairs of gloves were used is an _inventory_ fact. Whether the
patient pays for them is a _commercial_ decision governed by a charge policy.
Inventory consumption **never** creates an invoice line as a side effect.

The seam is `charge_requests`: consumption (or dispensing) emits a structured
request; a separate step resolves the charge policy and, where the answer is
"bill it", calls the existing invoice engine.

**Consequence:** the same glove is `INCLUDED_IN_SERVICE` under one payer and
`SEPARATELY_BILLABLE` under another with zero change to the consumption code.

See [CLINICAL_CONSUMPTION.md](CLINICAL_CONSUMPTION.md) and
[BILLING_INTEGRATION.md](BILLING_INTEGRATION.md).

---

## PI-ADR-006 — This programme adds no tax logic

**Status:** Accepted

`@rcln/tax` is already country-generic: `(country_code, region_code)`
jurisdictions, `GST`/`VAT`/`SALES_TAX` schemes, a `TaxSplit` for India's CGST/SGST
halves, effective-dated rules with tenant-beats-platform precedence, and a
`TaxProviderQuote` seam for regimes that cannot honestly be computed from a rate
table (US sales tax, EU OSS).

The product platform's **only** tax responsibility is to resolve, for a given
product in a given jurisdiction on a given date, the exact-match `tax_category`
string that keys `tax_rules`. Everything after that already works.

`invoice_items.item_code` (the printed HSN/SAC) and `invoice_items.tax_category`
(the lookup key) are already separate columns in this schema. The brief's
requirement that HSN must not be the universal product identifier is therefore
already satisfied upstream — do not "fix" it.

**No `if (country === 'IN')` in this programme.** Not in a service, not in a
controller, not in a component.

---

## PI-ADR-007 — The regulatory engine is a pure package, mirroring `@rcln/tax`

**Status:** Accepted

`@rcln/regulatory` holds no Prisma client and reads no database. The caller
loads the rows and passes them in; the package returns a decision. Same shape as
`@rcln/tax`, for the same reason: every rule becomes testable without a tenant,
a transaction or a clock.

```ts
evaluate(request: RegulatoryRequest): RegulatoryDecision
```

A jurisdiction with no applicable rule returns a **refusal with a reason**, never
a permissive default — the same choice `@rcln/tax` makes with `UNRATED`. A
guessed rule is a plausible, confident, wrong answer, which is worse than a
visible gap.

See [REGULATORY_ARCHITECTURE.md](REGULATORY_ARCHITECTURE.md).

---

## PI-ADR-008 — Regulatory rules are effective-dated data, and history is never restated

**Status:** Accepted

Every rule carries `effective_from`, `effective_to`, `version`, `status`,
`source_id`, `authority_id`, `last_reviewed_at`. Rules are never edited in place;
a change is a new version with a new effective date.

Every dispensing and consumption record **snapshots the decision** that was made
and cites the rule version that made it. Re-running the engine over a historical
transaction must never be necessary, and must never change what that transaction
says.

This is the same discipline the invoice engine already applies to tax: _"every
tax field is a snapshot and is never re-read."_

---

## PI-ADR-009 — Regulatory maturity is a state, not a boolean ⬆

**Status:** Accepted

A country configuration existing is not compliance. Each rule pack carries one
of:

```
ARCHITECTURE_SUPPORTED → RULES_CONFIGURED → RULES_IMPLEMENTED
  → AUTOMATED_TESTED → SOURCE_VERIFIED → REGULATORY_REVIEW_PENDING
  → PRODUCTION_ENABLED
```

**Only a human with legal authority may set `REGULATORY_REVIEWED` /
`PRODUCTION_ENABLED`.** No code path, migration, seed or agent sets those states.
Anything below `PRODUCTION_ENABLED` surfaces a visible banner in the regulatory
screens.

Neither this repository nor any agent working in it claims legal compliance for
any jurisdiction.

---

## PI-ADR-010 — Quantities are Decimal; money is integer minor units

**Status:** Accepted

- **Inventory quantity:** `Decimal(18,6)` on the ledger. Base units include mL,
  mg and fractional tablets; 3 decimal places is not enough for a base unit of
  mg expressed in a pack of g. `invoice_items.quantity` stays `Decimal(14,3)` —
  the charge quantity is a different, coarser number and that column is frozen.
- **Money:** integer minor units via `@rcln/payments`'s `Money`, consistent with
  every other package. Where a value must live in Postgres beside an invoice
  column, `Decimal(14,2)` matches the existing convention.
- **Never a float.** Repository rule, not negotiable.
- **Unit cost** is stored per _base unit_, so a pack-size change does not
  invalidate history.

---

## PI-ADR-011 — Product permissions get a new `product` module; `pharmacy.medicine.*` is retained

**Status:** Accepted (low confidence — see [OPEN_DECISIONS.md](OPEN_DECISIONS.md) OD-1)

`pharmacy.medicine.read` / `.manage` already exist and are granted to
`PHARMACIST`. But under PI-ADR-001 the catalogue is not a pharmacy concern — a
dentist manages dental materials and a lab manager manages reagents, and neither
should need a pharmacy code.

So: add a `product` module (`product.definition.read`, `product.definition.manage`,
`product.identifier.manage`, `product.regulatory.read`, `product.regulatory.manage`)
and **keep `pharmacy.medicine.*` as the narrower gate on medicine-specific
attributes** — prescription classification, controlled scheduling, composition.
A pharmacist holds both; a dental store manager holds only the `product.*` pair.

No code is deleted and no grant is revoked, so this is additive and reversible.

---

## PI-ADR-012 — Inventory locations sit below branch, and branch remains the RLS boundary

**Status:** Accepted

```
Organization → Branch → Inventory Location → Storage Area → Bin
```

`inventory_locations` is branch-scoped and joins the `branch_scoped` RLS array.
Storage areas and bins are children of a location and are _not_ separately
branch-scoped — they inherit through a composite FK, the way invoice children
inherit from invoices.

A location has a `LocationKind` (`MAIN_PHARMACY`, `REFRIGERATOR`,
`CONTROLLED_CABINET`, `DEPARTMENT_STORE`, `PROCEDURE_ROOM`, `LAB_STORE`,
`CENTRAL_WAREHOUSE`, …). Kind is metadata for the UI and for regulatory storage
checks. **Never branch authorization on it** — the same rule the clinical
taxonomy's `TaxonomyNodeType` already carries.

---

## PI-ADR-013 — Product status and inventory status are different things ⬆

**Status:** Accepted

A product can be `ACTIVE` while a specific batch is `RECALLED`. A product can be
`DISCONTINUED` while three batches remain `AVAILABLE` and must still be
dispensable. Two enums, two columns, no shared vocabulary, and no code that
reads one to infer the other.

---

## PI-ADR-014 — The tracking mode is a product property, evaluated at movement time

**Status:** Accepted

`products.tracking_mode ∈ { NONE, LOT_BATCH, SERIAL, LOT_AND_SERIAL }`, with
`is_expiry_controlled` as an orthogonal boolean rather than a fifth mode —
because "batch-tracked and expiry-controlled" and "batch-tracked, no expiry"
are both real, and folding them into one enum makes the third combination
inexpressible.

Every ledger write validates the movement against the product's mode: a
`SERIAL` product moving without a serial id is refused **in the database** via a
CHECK constraint, not only in the service. A jurisdiction may _raise_ the
requirement (GTIN + lot + expiry + serial); it may never lower it.

---

## PI-ADR-015 — Alert thresholds are settings, not constants

**Status:** Accepted

Near-expiry windows, low-stock levels, reorder points and FEFO override
tolerances resolve through the existing settings resolver
(USER → DOCTOR → BRANCH → ORGANIZATION → PLATFORM → definition default). No
`const NEAR_EXPIRY_DAYS = 30` anywhere.

⚠️ `setting_values` is **RLS-exempt** — the explicit `(scopeType, scopeId)` pair
every read passes is the only tenant isolation there is, and `db:rls:check`
cannot notice a missing one. Every new setting read in this programme must pass
the pair explicitly and must have a test that proves cross-tenant reads fail.

---

## PI-ADR-016 — Dispensing and consumption records are PHI reads

**Status:** Accepted

Reading who was dispensed what is a disclosure about a named person. Every such
read writes a `data_access_logs` row through the existing `recordDataAccess`,
with a new `DataAccessResource` member for dispensing. Ids, enums and counts
only — never a product name, never a patient name, in that table.

The existing `REDACTED_KEYS` backstop gains the new PHI-adjacent field names.

---

## PI-ADR-017 — Veterinary is a subject type on `patients`, not a parallel model

**Status:** Accepted · **Implemented in PI-11 (2026-08-19)**

`patients` gains a subject discriminator; an `animal_profiles` extension row
carries species, breed, weight and sex, and the owner is an existing contact.
The product and inventory engines do not change at all — only regulatory
profiles and dosing rules differ, and both are already per-jurisdiction data.

**As built, with three notes the ADR did not anticipate:**

- **The discriminator and the table arrived early, in CE-1**, because §4 asked
  that the architecture stop assuming humans while §42.7 forbade building
  veterinary features. They then sat empty and unreachable for the whole
  intervening programme. PI-11 is the enablement layer, and it added no table.
- **"The owner is an existing contact" was not what CD-4 shipped** — it wrote
  two free-text columns. PI-11 added `guardian_contact_id`, composite-FK'd to
  `patient_contacts`, and kept the free text for the walk-in whose owner is not
  a contact row yet. A CHECK makes the two mutually exclusive. ⚠️ The composite
  FK constrains the TENANT, not the parent: naming a DIFFERENT animal's owner at
  the same clinic is representable, and the service checks it.
- **"Sex" is `patients.gender`**, not a column on the profile. An animal is a
  `patients` row and the human fields still mean something.

⚠️ **"Only regulatory profiles and dosing differ" understated the regulatory
half.** Differing profiles needed no code — a profile is per product per
jurisdiction already. What was missing was a way for a jurisdiction to say WHO a
product may be supplied for, so PI-11 added the `SPECIES_RESTRICTION` rule type.
**It added no India rule**: rules 65(20) and 97(3) require the LABEL and do not
prohibit the sale, and the step between the two is an inference. See the tracker.

---

## Integration seams, precisely

| Seam                              | Direction | Contract                                                                                                    |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| Product → Tax                     | out       | `resolveTaxCategory(productId, jurisdiction, on) → string`. Fed to `invoice_items.tax_category`.            |
| Dispensing/Consumption → Billing  | out       | `charge_requests` row → `createInvoiceFor…` in `services/invoicing`. Never a direct `invoice_items` insert. |
| Pharmacy → Prescription           | in        | Read-only. Pharmacy never writes a prescription. Invariant 7.                                               |
| Consumption → Encounter/Procedure | in        | Read-only reference by id + composite FK.                                                                   |
| Any domain → Inventory            | in        | `recordMovement(...)` only. No caller touches `stock_balances`.                                             |
| Any domain → Regulatory           | in        | `evaluate(...)` only. No caller reads a rule row directly.                                                  |
| Inventory → Numbering             | out       | `issueNumber()`. New `NumberSequenceType` members.                                                          |
| Everything → Audit                | out       | `recordAudit` for mutations, `recordDataAccess` for PHI reads.                                              |
| Everything → Documents            | out       | `@rcln/documents` + `@rcln/storage`. No new PDF path.                                                       |

---

## What this programme must never do

- Import the raw Prisma client, or anything under `generated/prisma`
- Add a tenant table without an RLS policy, the SQL appended to the migration,
  and a case in the tenant-isolation suite
- Write a bare `@@unique([code])` on a tenant table
- Compute a tax rate, split a tax line, or format a tax label
- Insert an `invoice_item` directly
- Reorder the API middleware chain, or 403 an unknown tenant
- Put a permission list in a JWT
- Log a product name against a patient, or cache PHI in Redis
- Use a float for money or an `isDeleted` boolean for soft delete
- Claim legal compliance for any jurisdiction
