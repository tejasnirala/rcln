# Implementation Tracker

**The authority on task state.** Update it as you work, not at the end.

**Last updated:** 2026-08-11

## Status vocabulary

```
NOT_STARTED         nothing done
PLANNED             scoped in this tracker, not begun
IN_PROGRESS         actively being built
BLOCKED             cannot proceed; the blocker is named
PARTIALLY_COMPLETE  some legs done, others not; the gap is named
COMPLETE            every applicable leg done — see the gate below
DEFERRED            deliberately postponed; the reason is recorded
```

## The completion gate

A task is `COMPLETE` only when **all applicable** legs are done, and any leg that
does not apply is explicitly marked `n/a` with a one-line reason:

`DB` migration + RLS policy + isolation test · `BE` service via `withTenant` ·
`API` contract in `@rcln/contracts` + route + middleware chain · `FE` screen ·
`VAL` Zod validation · `AUTHZ` permission code enforced · `AUDIT` `recordAudit`
/ `recordDataAccess` · `REG` regulatory hook where relevant · `TEST` unit +
integration + isolation · `DOC` this directory updated · `REGRESS`
`pnpm validate` and `pnpm db:rls:check` green.

**Code written ≠ complete.** Do not mark a row `COMPLETE` because it compiles.

---

## Phase roll-up

| Phase     | Title                                                   | Status                    | Blocked by                                  |
| --------- | ------------------------------------------------------- | ------------------------- | ------------------------------------------- |
| PI-0      | Discovery & Architecture                                | **COMPLETE** (2026-08-11) | —                                           |
| PI-1      | Product Platform Core                                   | PLANNED                   | —                                           |
| PI-2      | Inventory Foundation                                    | PLANNED                   | PI-1                                        |
| PI-3      | Movements                                               | PLANNED                   | PI-2                                        |
| PI-4      | Procurement                                             | PLANNED                   | PI-3                                        |
| PI-5      | Global Regulatory Framework                             | PLANNED                   | PI-1                                        |
| PI-6      | India Rule Pack                                         | PLANNED                   | PI-5                                        |
| PI-7      | Pharmacy Dispensing                                     | **BLOCKED**               | `prescriptions` (Phase 3) + PI-3 + PI-5     |
| PI-8      | Billing & Tax Integration                               | PLANNED                   | PI-3 (counter-sale path); PI-7 for the rest |
| PI-9      | Clinical Consumption                                    | **BLOCKED**               | `encounters`/`procedures` (Phase 3) + PI-3  |
| PI-10     | Recall & Traceability                                   | PLANNED                   | PI-2, PI-4                                  |
| PI-11     | Veterinary Enablement                                   | PLANNED                   | PI-1, PI-5                                  |
| PI-12     | Online Pharmacy                                         | PLANNED                   | PI-7, PI-8                                  |
| PI-13..21 | Country Rule Packs (US, UK, AU, SG, AE, IE, NP, LK, BD) | NOT_STARTED               | PI-6                                        |
| PI-22     | Reporting & Cost Accounting                             | NOT_STARTED               | PI-4                                        |
| PI-23     | Identifier Resolution / Barcode                         | NOT_STARTED               | PI-1, PI-2                                  |
| PI-24     | Global Hardening                                        | NOT_STARTED               | everything                                  |

---

# PI-0 — Discovery & Architecture · COMPLETE

| Task   | Description                                                                                         | Status   |
| ------ | --------------------------------------------------------------------------------------------------- | -------- |
| PI-0.1 | Repository audit — tenancy, RLS, RBAC, billing, tax, invoice, audit, settings, documents, web shell | COMPLETE |
| PI-0.2 | Identify reusable infrastructure and existing pharmacy/inventory permission codes                   | COMPLETE |
| PI-0.3 | Identify gaps, conflicts and hard blockers (`prescriptions`, `encounters`)                          | COMPLETE |
| PI-0.4 | Documentation directory + 29 documents                                                              | COMPLETE |
| PI-0.5 | Architecture decisions PI-ADR-001..017                                                              | COMPLETE |
| PI-0.6 | Phased plan + this tracker                                                                          | COMPLETE |
| PI-0.7 | Country support matrix skeleton (values honestly `RESEARCH_REQUIRED`)                               | COMPLETE |

**Completion date:** 2026-08-11 · **Next action:** PI-1.1

---

# PI-1 — Product Platform Core · PLANNED

**Dependencies:** none. **Priority:** P0 — everything else waits on it.
**Regulatory:** none in this phase; PI-5 attaches profiles to these products.

---

### PI-1.1 — Unit of measure & packaging engine

Base units, unit classes (count / volume / mass), packaging hierarchies
(`case → box → strip → tablet`, `bottle → 100 mL`, `pack → 10 pairs`), and the
conversion algebra to and from a product's base unit.

- **DB** `units_of_measure` (platform + tenant extension, PI-ADR-003),
  `product_packagings` (tenant, parented to product)
- **BE** `convertToBase` / `convertFromBase`; exact rational conversion, no
  floating point; refuse a conversion that crosses unit classes
- **API** `GET /v1/units`, unit management under `product.definition.manage`
- **FE** unit picker component; packaging editor inside the product form
- **TEST** conversion algebra incl. multi-level hierarchies and rounding;
  cross-class refusal; RLS isolation on tenant-created units
- **Notes** ⚠️ This lands first because every quantity in the programme is
  denominated by it. Getting it wrong is a second migration under data.
- **Files** `packages/db/prisma/schema.prisma`, `.../rls/enable-rls.sql`,
  `packages/contracts/src/products.ts`, `apps/api/src/services/product/`,
  `apps/web/.../(app)/products/`
- **Status** NOT_STARTED · **Next action** run `/db-migration units and packaging`

---

### PI-1.2 — Product core & categories

- **DB** `products` (platform + tenant extension), `product_categories`
  (`parent_id` only — reuse the taxonomy shape, do not invent a second),
  `ProductType` enum with the 12 members from the brief plus room to grow,
  `ProductStatus` enum (PI-ADR-013)
- **BE** product CRUD via `withTenant`; a tenant may clone a platform product
  into its own row but never edit one
- **API** `/v1/products` list/create/read/update, `/v1/product-categories`
- **FE** product list with server-side search and pagination; create wizard;
  detail page
- **AUTHZ** new `product.definition.read` / `.manage` (PI-ADR-011)
- **AUDIT** `recordAudit` on create/update/status change
- **TEST** ⚠️ **the RESTRICTIVE `*_visible` policy test** — a tenant must not be
  able to attach another tenant's private product anywhere
- **Status** NOT_STARTED · **Depends on** PI-1.1

---

### PI-1.3 — Manufacturers

`manufacturers` (platform + tenant extension), address, country, licence
identifiers. Referenced by products and by batches (a batch's manufacturer may
differ from the product's).

- **Status** NOT_STARTED · **Depends on** PI-1.2

---

### PI-1.4 — Active ingredients, compositions, and the generic/brand triangle

```
active_ingredients ──< composition_ingredients >── compositions ──< products
                          (strength, unit)
```

A composition is a named set of ingredients with strengths. Many products
(brands and generics) reference one composition — this is what makes
substitution answerable at all.

- **DB** `active_ingredients`, `compositions`, `composition_ingredients`
  (strength + strength unit per ingredient — **never one ingredient per medicine**)
- **BE** composition equivalence lookup: "what else has this composition"
- **API** `/v1/compositions`, `/v1/active-ingredients`
- **FE** composition builder inside the product form; "equivalent products" panel
- **TEST** multi-ingredient compositions; equivalence across brands
- **Notes** Substitution _permission_ is regulatory (PI-5) and is not decided here.
- **Status** NOT_STARTED · **Depends on** PI-1.2

---

### PI-1.5 — Medicine details extension

`medicine_details` keyed 1:1 to product: dosage form, route, release type,
prescription classification placeholder (the real classification is
per-jurisdiction and lands in PI-5), storage requirement reference.

- **AUTHZ** gated by `pharmacy.medicine.manage` — the narrower existing code
- **Status** NOT_STARTED · **Depends on** PI-1.4

---

### PI-1.6 — Product identifiers

`product_identifiers`: `(product, type, value, jurisdiction?, effective_from,
effective_to)`. Types: `GTIN`, `EAN`, `UPC`, `NDC`, `NATIONAL_CODE`,
`MANUFACTURER_CODE`, `INTERNAL_SKU`, `LOCAL_REGULATORY`, extensible.

- **DB** ⚠️ uniqueness is **tenant-qualified and type-qualified**, never a bare
  `@@unique([value])`. A GTIN is globally unique in principle and routinely is
  not in practice.
- **BE** resolver: `resolveIdentifier(value) → { product, kind, jurisdiction }`
- **TEST** the same value under two types; expired identifiers excluded
- **Notes** PI-23 builds the GS1/DataMatrix decode layer on top of this.
- **Status** NOT_STARTED · **Depends on** PI-1.2

---

### PI-1.7 — Product tax classification

`product_tax_classifications`: `(product, country_code, region_code?,
tax_category, item_code?, effective_from, effective_to)`.

- **BE** `resolveTaxCategory(productId, jurisdiction, on) → string | null`.
  `null` is a **visible configuration gap**, not a default — the invoice engine
  already refuses to issue an `UNRATED` line.
- **TEST** effective-date selection; region beats country; missing → null, never
  a guess
- **Notes** `tax_category` keys `tax_rules` by exact match. `item_code` is the
  printed HSN/SAC, presentation only. PI-ADR-006.
- **Status** NOT_STARTED · **Depends on** PI-1.2

---

### PI-1.8 — Storage requirements & inventory configuration

`storage_requirement_profiles` (temperature range, humidity, light, controlled
access, hazard class) referenced by product. Product-level inventory config:
`tracking_mode`, `is_expiry_controlled`, `base_unit`, default shelf life,
reorder defaults.

- **DB** the CHECK constraint from PI-ADR-014 lands with the ledger in PI-2;
  the columns land here
- **Status** NOT_STARTED · **Depends on** PI-1.1, PI-1.2

---

### PI-1.9 — Product screens

List (fast search by name, generic, brand, SKU, GTIN, ingredient, manufacturer,
category), create/edit wizard, detail with tabs for identifiers, packaging,
composition, tax classification, storage.

- **FE** ⚠️ load `frontend-design` before the first line of JSX. Consult
  `vercel-react-best-practices` — this is a large list surface and must paginate
  server-side, never load the catalogue into memory.
- **Status** NOT_STARTED · **Depends on** PI-1.2..PI-1.8

---

### PI-1.10 — PI-1 hardening

`pnpm validate` + `db:rls:check` green; `/code-review`; `security-reviewer` on
the whole diff (it touches the schema and tenancy, so it is mandatory); update
`.kb/STATUS.md`; update this directory.

- **Status** NOT_STARTED

---

# PI-2 — Inventory Foundation · PLANNED

**Dependencies:** PI-1. **Priority:** P0.

| Task    | Description                                                                                               | Key risk                                                  | Status      |
| ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| PI-2.1  | `inventory_locations` + storage areas + bins (PI-ADR-012)                                                 | branch-scoped RLS array membership                        | NOT_STARTED |
| PI-2.2  | `batches` — lot, mfg/expiry/retest, cost per base unit, supplier, manufacturer, status                    | tenant-qualified lot uniqueness                           | NOT_STARTED |
| PI-2.3  | `serials` — serial, product, batch, location, status, patient assignment                                  | patient assignment is PHI                                 | NOT_STARTED |
| PI-2.4  | **`stock_ledger`** — append-only, both enforcement layers, movement-type enum, reference type + id        | ⚠️ the most important table in the programme              | NOT_STARTED |
| PI-2.5  | `stock_balances` — trigger-maintained cache + a replay verifier                                           | trigger correctness under concurrency                     | NOT_STARTED |
| PI-2.6  | Inventory status enum + transitions, kept distinct from product status                                    | PI-ADR-013                                                | NOT_STARTED |
| PI-2.7  | Tracking-mode CHECK constraints (PI-ADR-014)                                                              | must be in the DB, not only the service                   | NOT_STARTED |
| PI-2.8  | Expiry: near-expiry settings, a worker sweep, quarantine-on-expiry                                        | ⚠️ first real worker processor in the repo                | NOT_STARTED |
| PI-2.9  | Recall/quarantine **columns** (workflow deferred to PI-10)                                                | capability now, workflow later                            | NOT_STARTED |
| PI-2.10 | Screens: dashboard, stock by location, batch, serial, expiry, ledger                                      | ledger view must paginate                                 | NOT_STARTED |
| PI-2.11 | Tests: ledger/balance agreement under 50 parallel writes; no negative balance; RLS across every new table | mirror the numbering concurrency test that already exists | NOT_STARTED |
| PI-2.12 | PI-2 hardening                                                                                            |                                                           | NOT_STARTED |

---

# PI-3 — Movements · PLANNED

| Task   | Description                                                              | Status      |
| ------ | ------------------------------------------------------------------------ | ----------- |
| PI-3.1 | Adjustments with mandatory reason codes                                  | NOT_STARTED |
| PI-3.2 | Intra-branch transfers (location → location)                             | NOT_STARTED |
| PI-3.3 | Inter-branch transfers, with in-transit state                            | NOT_STARTED |
| PI-3.4 | Reservations — `RESERVED` made real, with expiry/release                 | NOT_STARTED |
| PI-3.5 | FEFO allocation service, with product- and jurisdiction-level overrides  | NOT_STARTED |
| PI-3.6 | Screens: transfers, adjustments, reservations                            | NOT_STARTED |
| PI-3.7 | Tests: transfer atomicity, no negative balance, FEFO ordering incl. ties | NOT_STARTED |

---

# PI-4 — Procurement · PLANNED

| Task    | Description                                                                           | Status      |
| ------- | ------------------------------------------------------------------------------------- | ----------- |
| PI-4.1  | `suppliers` + supplier tax identifiers                                                | NOT_STARTED |
| PI-4.2  | `supplier_products` — supplier SKU, pack size, price, lead time                       | NOT_STARTED |
| PI-4.3  | Purchase requisitions + approval                                                      | NOT_STARTED |
| PI-4.4  | Purchase orders + lines; `NumberSequenceType.PURCHASE_ORDER`                          | NOT_STARTED |
| PI-4.5  | Goods receipts + lines, with batch/serial capture; `NumberSequenceType.GOODS_RECEIPT` | NOT_STARTED |
| PI-4.6  | Quality / acceptance step; rejected stock → `QUARANTINED`                             | NOT_STARTED |
| PI-4.7  | Purchase returns                                                                      | NOT_STARTED |
| PI-4.8  | Costing: purchase cost, moving average, cost per base unit                            | NOT_STARTED |
| PI-4.9  | Screens: suppliers, PO workspace, GRN capture, returns                                | NOT_STARTED |
| PI-4.10 | Tests: receipt writes ledger; over-receipt refused; cost roll-up                      | NOT_STARTED |

---

# PI-5 — Global Regulatory Framework · PLANNED

| Task   | Description                                                                                   | Status      |
| ------ | --------------------------------------------------------------------------------------------- | ----------- |
| PI-5.1 | `jurisdictions`, `regulatory_authorities`                                                     | NOT_STARTED |
| PI-5.2 | `regulatory_rules` + `regulatory_rule_packs`, versioned and effective-dated (PI-ADR-008)      | NOT_STARTED |
| PI-5.3 | `regulatory_sources` — the source registry                                                    | NOT_STARTED |
| PI-5.4 | `product_regulatory_profiles` — one product, many jurisdictions                               | NOT_STARTED |
| PI-5.5 | `@rcln/regulatory` — the pure evaluation package (PI-ADR-007)                                 | NOT_STARTED |
| PI-5.6 | Rule-pack maturity states + the "not compliance" banner (PI-ADR-009)                          | NOT_STARTED |
| PI-5.7 | New permission codes `regulatory.*`                                                           | NOT_STARTED |
| PI-5.8 | Screens: jurisdictions, authorities, product regulatory profile, rule status/version, sources | NOT_STARTED |
| PI-5.9 | Tests: rule resolution by date; region beats country; **no rule → refuse, never permit**      | NOT_STARTED |

---

# PI-6 — India Rule Pack · PLANNED

| Task                                                                          | Status      |
| ----------------------------------------------------------------------------- | ----------- |
| PI-6.1 Research + populate `regulatory_sources` with authoritative citations  | NOT_STARTED |
| PI-6.2 Prescription classification and schedule handling                      | NOT_STARTED |
| PI-6.3 Quantity, refill and record-retention rules                            | NOT_STARTED |
| PI-6.4 Labelling fields; online dispensing position                           | NOT_STARTED |
| PI-6.5 Per-rule tests (behaviour, never `country === 'IN'`)                   | NOT_STARTED |
| PI-6.6 Update `COUNTRY_SUPPORT_MATRIX.md`; set maturity to `AUTOMATED_TESTED` | NOT_STARTED |

---

# PI-7 — Pharmacy Dispensing · BLOCKED

**Blocked by:** `prescriptions` does not exist (Phase 3, Core clinical), plus
PI-3 and PI-5.

Epics, to be expanded into tasks when unblocked: prescription queue ·
pharmacist verification · regulatory validation · stock availability ·
substitution · batch allocation (FEFO) · dispensing transaction · dispensing
ledger · returns · OTC counter sales · pharmacy dashboard · pharmacy reports.

---

# PI-8 — Billing & Tax Integration · PLANNED

| Task                                                                                          | Status      | Note                       |
| --------------------------------------------------------------------------------------------- | ----------- | -------------------------- |
| PI-8.1 `charge_requests` table + service (PI-ADR-005)                                         | NOT_STARTED |                            |
| PI-8.2 Charge policy resolution (product / procedure / facility / payer / country / contract) | NOT_STARTED |                            |
| PI-8.3 Wire `InvoiceSourceType.PHARMACY` and `.INVENTORY`                                     | NOT_STARTED | enum members already exist |
| PI-8.4 `resolveTaxCategory` → `invoice_items.tax_category`                                    | NOT_STARTED | no tax code written        |
| PI-8.5 Charge review screen                                                                   | NOT_STARTED |                            |
| PI-8.6 Tests: glove → no line; implant → a line; tax via the existing engine only             | NOT_STARTED |                            |

---

# PI-9 — Clinical Consumption · BLOCKED

**Blocked by:** `encounters` / `procedures` do not exist (Phase 3), plus PI-3.

Epics: consumption templates per procedure · expected vs actual · clinician
override with audit · inventory movement on actual · dental / veterinary / lab
reuse · consumption history and inventory impact screens.

---

# PI-10 .. PI-24

Epic-level only until their dependencies land. See
[MASTER_PLAN.md](MASTER_PLAN.md) for scope. Expand into tasks at phase start.

| Phase     | Epics                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------- |
| PI-10     | recall create/execute · affected stock · blocked dispensing · traceability queries · reports       |
| PI-11     | patient subject type · `animal_profiles` · veterinary regulatory profiles · dosing                 |
| PI-12     | online order · jurisdiction gating · allocation · packing · shipping · delivery                    |
| PI-13..21 | one rule pack each: US, UK, AU, SG, AE, IE, NP, LK, BD                                             |
| PI-22     | valuation · aging · movement · dead stock · consumption cost · contribution · supplier performance |
| PI-23     | GS1/DataMatrix decode · identifier resolution → product + batch + serial · scanner UX              |
| PI-24     | security review · performance/index audit · E2E · migration rehearsal · production gates           |
