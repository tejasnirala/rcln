# Implementation Tracker

**The authority on task state.** Update it as you work, not at the end.

**Last updated:** 2026-08-16 (PI-7 complete)

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

| Phase     | Title                                                   | Status                    | Blocked by                                 |
| --------- | ------------------------------------------------------- | ------------------------- | ------------------------------------------ |
| PI-0      | Discovery & Architecture                                | **COMPLETE** (2026-08-11) | —                                          |
| PI-1      | Product Platform Core                                   | **COMPLETE** (2026-08-11) | —                                          |
| PI-2      | Inventory Foundation                                    | **COMPLETE** (2026-08-12) | —                                          |
| PI-3      | Movements                                               | **COMPLETE** (2026-08-12) | —                                          |
| PI-4      | Procurement                                             | **COMPLETE** (2026-08-13) | —                                          |
| PI-5      | Global Regulatory Framework                             | **COMPLETE** (2026-08-13) | —                                          |
| PI-6      | India Rule Pack                                         | **COMPLETE** (2026-08-13) | —                                          |
| PI-7      | Pharmacy Dispensing                                     | **COMPLETE** (2026-08-16) | —                                          |
| PI-8      | Billing & Tax Integration                               | PLANNED                   | **UNBLOCKED** — PI-7 landed                |
| PI-9      | Clinical Consumption                                    | **BLOCKED**               | `encounters`/`procedures` (Phase 3) + PI-3 |
| PI-10     | Recall & Traceability                                   | PLANNED                   | PI-2, PI-4                                 |
| PI-11     | Veterinary Enablement                                   | PLANNED                   | PI-1, PI-5                                 |
| PI-12     | Online Pharmacy                                         | PLANNED                   | PI-8                                       |
| PI-13..21 | Country Rule Packs (US, UK, AU, SG, AE, IE, NP, LK, BD) | NOT_STARTED               | PI-6                                       |
| PI-22     | Reporting & Cost Accounting                             | NOT_STARTED               | PI-4                                       |
| PI-23     | Identifier Resolution / Barcode                         | NOT_STARTED               | PI-1, PI-2                                 |
| PI-24     | Global Hardening                                        | NOT_STARTED               | everything                                 |

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

# PI-1 — Product Platform Core · COMPLETE

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
- **Status** COMPLETE

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
- **Status** COMPLETE

---

### PI-1.3 — Manufacturers

`manufacturers` (platform + tenant extension), address, country, licence
identifiers. Referenced by products and by batches (a batch's manufacturer may
differ from the product's).

- **Status** COMPLETE

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
- **Status** COMPLETE

---

### PI-1.5 — Medicine details extension

`medicine_details` keyed 1:1 to product: dosage form, route, release type,
prescription classification placeholder (the real classification is
per-jurisdiction and lands in PI-5), storage requirement reference.

- **AUTHZ** gated by `pharmacy.medicine.manage` — the narrower existing code
- **Status** COMPLETE

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
- **Status** COMPLETE

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
- **Status** COMPLETE

---

### PI-1.8 — Storage requirements & inventory configuration

`storage_requirement_profiles` (temperature range, humidity, light, controlled
access, hazard class) referenced by product. Product-level inventory config:
`tracking_mode`, `is_expiry_controlled`, `base_unit`, default shelf life,
reorder defaults.

- **DB** the CHECK constraint from PI-ADR-014 lands with the ledger in PI-2;
  the columns land here
- **Status** COMPLETE, PI-1.2

---

### PI-1.9 — Product screens

List (fast search by name, generic, brand, SKU, GTIN, ingredient, manufacturer,
category), create/edit wizard, detail with tabs for identifiers, packaging,
composition, tax classification, storage.

- **FE** ⚠️ load `frontend-design` before the first line of JSX. Consult
  `vercel-react-best-practices` — this is a large list surface and must paginate
  server-side, never load the catalogue into memory.
- **Status** COMPLETE..PI-1.8

---

### PI-1.10 — PI-1 hardening

`pnpm validate` + `db:rls:check` green; `/code-review`; `security-reviewer` on
the whole diff (it touches the schema and tenancy, so it is mandatory); update
`.kb/STATUS.md`; update this directory.

- **Status** PARTIALLY_COMPLETE
- **Done** 989 API tests across 35 suites green; `db:rls:check` green at 65
  protected tables; lint and `@rcln/api` typecheck green; `pnpm kb` regenerated;
  `.kb/STATUS.md` and this directory updated.
- **Done — `security-reviewer` over the whole diff.** PASS. Confirmed the
  read-permissive/write-strict policy, the thirteen-table list in both
  `enable-rls.sql` and the migration with no drift between them, the ten
  `*_visible` policies, the composite-FK argument against the MATCH SIMPLE
  objection, parameterised raw SQL throughout, no query outside `withTenant`, no
  PHI in logs, and non-escalating permissions. Five findings, none CRITICAL or
  HIGH: three fixed (`20260814100000_platform_rows_immutable`; isolation cases
  for the three untested children; the false slug-binding comment), two accepted
  and recorded in NEXT_SESSION.md § Known issues.
- **Done — `code-reviewer` over the whole diff.** It found two CRITICALs, both
  the same Prisma `where` mistake (a spread `OR` overwritten by a later literal
  `OR`, dropping the jurisdiction filter in the tax and identifier resolvers),
  plus six WARNINGs. All fixed, plus a THIRD bug the review missed that the
  regression tests caught: `orderBy: { regionCode: 'desc' }` relied on a comment
  claiming Postgres sorts NULLs last on DESC — it sorts them FIRST — so with
  `take: 1` every regional tax override was silently inert. It confirmed
  `units.ts` is sound: no precision or overflow defect.
- **Still open — the screens have not been opened in a browser.** Demo data for
  that is a throwaway SQL script, deliberately not a seed (OD-4).
- **Known red, not PI-1's** `@rcln/web#typecheck`, from untracked jest config
  and tests plus uninstalled devDeps. See NEXT_SESSION.md § Known issues 4.

---

# PI-2 — Inventory Foundation · COMPLETE

**Dependencies:** PI-1. **Priority:** P0. **Completed:** 2026-08-12 on
`feat/pi-2-inventory-foundation`.

| Task    | Description                                                               | Status                                   |
| ------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| PI-2.1  | `inventory_locations` + storage areas + bins (PI-ADR-012)                 | COMPLETE                                 |
| PI-2.2  | `batches` — lot, dates, cost per base unit, manufacturer, status          | COMPLETE                                 |
| PI-2.3  | `serials` — serial, product, batch, location, status, patient assignment  | COMPLETE                                 |
| PI-2.4  | **`stock_ledger`** — append-only, both layers, movement + reference enums | COMPLETE                                 |
| PI-2.5  | `stock_balances` — trigger-maintained cache + `verifyBalances()` replay   | COMPLETE                                 |
| PI-2.6  | Inventory status enums, kept distinct from product status                 | COMPLETE                                 |
| PI-2.7  | Tracking-mode CHECK constraints (PI-ADR-014)                              | COMPLETE                                 |
| PI-2.8  | Expiry: settings-driven window, worker sweep, quarantine-on-expiry        | COMPLETE                                 |
| PI-2.9  | Recall / quarantine columns, plus the hold endpoint                       | COMPLETE — workflow still PI-10          |
| PI-2.10 | Screens: overview, lots, serials, locations, ledger, plus the three forms | COMPLETE                                 |
| PI-2.11 | Tests: 50 parallel writes, no negative balance, RLS on every new table    | COMPLETE                                 |
| PI-2.12 | PI-2 hardening                                                            | COMPLETE — both reviews run and acted on |

### What landed

| Area        | What                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `packages/db/prisma/schema/inventory.prisma` — 7 models, 6 enums                                                                                            |
| Migrations  | `20260815090000_inventory_foundation`, `..091000_data_access_resource_inventory_serial`, `..092000_inventory_expiry_sweep_function`                         |
| RLS         | 7 tables in **both** `org_scoped` and `branch_scoped`; 7 RESTRICTIVE `*_visible` policies. `db:rls:check` green at **72** tables                            |
| Enforcement | `stock_ledger_direction`, `_bucket_complete`, `_tracking_satisfied`, `_entered_agrees`, `_cost_has_currency`; `stock_balances_non_negative`; 4 on `batches` |
| Grants      | `stock_ledger`: no UPDATE/DELETE. `stock_balances`: **SELECT only** — the cache is trigger-maintained and unwritable by the app                             |
| Package     | **`@rcln/inventory`** — the ledger writer and the conversion algebra, extracted so the worker can share them                                                |
| Permissions | `inventory.location.manage`, granted to BRANCH_ADMIN and PHARMACIST                                                                                         |
| Contracts   | `packages/contracts/src/inventory.ts`                                                                                                                       |
| Services    | `services/inventory/` — movement, location, batch, serial, balance, expiry                                                                                  |
| Routes      | `/v1/{inventory-locations,batches,serials,stock}`                                                                                                           |
| Worker      | `apps/worker/src/inventory/expiry.processor.ts` — hourly, branch-timezone-aware                                                                             |
| Web         | `/stock` (overview, lots, serials, locations, ledger) plus forms for a location, a lot and a serial; "Stock" nav entry                                      |
| Tests       | `tests/unit/inventory-movement.test.ts` (14), `tests/integration/stock-ledger.test.ts` (25), +32 isolation cases. **1087 API tests across 39 suites**       |
| Reviews     | `security-reviewer` and `code-reviewer` both run. 2 CRITICAL, 1 HIGH, 11 WARNING — all fixed bar two accepted. See [CHANGELOG.md](CHANGELOG.md)             |

### The one deliberate deviation, recorded

`EXPIRY`, `DAMAGE` and `RECALL` are **MOVES between status buckets, not `−`
removals**, which refines INVENTORY_ARCHITECTURE.md's sign table. Expired stock
has not left the building: it is on the shelf, undispensable, waiting to be
destroyed, and it has to be counted and valued until it is — which is what that
same document's status model says. `DISPOSAL` is the `−` that records a physical
departure. See the `StockMovementType` enum comment.

### Deliberately NOT in PI-2, and where each belongs

- **Recording a movement (an adjustment) has no screen.** `POST
/v1/stock/movements` exists, is gated on `inventory.stock.adjust` and is
  exercised by tests. The SCREEN is **PI-3.6** — "Screens: transfers,
  adjustments, reservations" — sitting on PI-3.1's adjustment work.
- **The recall / quarantine workflow has no screen.** `POST /batches/:id/hold`
  works and moves quantity in the same transaction as the flag. PI-2.9 is
  explicit that this phase delivers the CAPABILITY and **PI-10** delivers the
  workflow.
- **Assigning a serial to a patient has no screen.** `POST /serials/:id/assign`
  exists. The moment a device is fitted is a clinical one and belongs beside the
  procedure that fitted it — **PI-9**.

### Follow-ups the reviews raised and PI-2 did not take

- **`toDateColumn` still has three older copies** in `doctor.service.ts`,
  `patient.service.ts` and `patient-history.service.ts`, in three subtly
  different signatures. The canonical one is now `product/values.ts`; collapsing
  the other three means touching Phase 3 services and their tests, which is not
  this phase's change to make.
- **A worker-only database role.** Two SECURITY DEFINER discovery functions —
  `billing_due_subscriptions` and `inventory_branches_with_expired_stock` — are
  granted to `rcln_app` because the worker connects as it. Both are read-only and
  neither takes a widening argument, but the request path holding them is a
  standing HIGH. Infrastructure work; belongs in **PI-24**.
- **`listLocations` is the one unpaginated list.** Accepted, with the reasoning
  and the threshold recorded in the service.

### Still open

- **Nothing has been clicked in a browser.**

---

# PI-3 — Movements · COMPLETE (2026-08-12)

| Task   | Description                                                              | Status       |
| ------ | ------------------------------------------------------------------------ | ------------ |
| PI-3.1 | Adjustments with mandatory reason codes                                  | **COMPLETE** |
| PI-3.2 | Intra-branch transfers (location → location)                             | **COMPLETE** |
| PI-3.3 | Inter-branch transfers, with in-transit held by the DOCUMENT             | **COMPLETE** |
| PI-3.4 | Reservations — `RESERVED` made real, with expiry/release                 | **COMPLETE** |
| PI-3.5 | FEFO allocation service, with product-level override; PI-5 seam left     | **COMPLETE** |
| PI-3.6 | Screens: transfers, adjustments, reservations                            | **COMPLETE** |
| PI-3.7 | Tests: transfer atomicity, no negative balance, FEFO ordering incl. ties | **COMPLETE** |

| Area        | What landed                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Schema      | 4 tables, 3 enums + `AllocationStrategy`, `products.allocation_strategy`, `NumberSequenceType.STOCK_TRANSFER`                        |
| Migrations  | 4 (`..816090000` movements · `..091000` sweep fn · `..092000` location snapshot · `..093000` lot snapshot)                           |
| RLS         | `db:rls:check` green at **76**. `stock_reason_codes` is platform-extensible; transfers carry a bespoke two-ended `from OR to` policy |
| Package     | `@rcln/inventory` gains `allocate.ts` (pure FEFO/FIFO/LIFO) and `reservation-sweep.ts`                                               |
| Permissions | `inventory.stock.reserve`, `inventory.reason_code.manage` → BRANCH_ADMIN + PHARMACIST                                                |
| Routes      | `/v1/stock/{reason-codes,reservations,allocations/plan}` and `/v1/stock-transfers/*`                                                 |
| Worker      | The reservation sweep, on the inventory queue at `:30`. `movementDeps` extracted to `inventory/deps.ts`                              |
| Web         | `/stock/transfers` (list, new, detail+receive), `/stock/reservations`, `/stock/adjustments/new`; two new nav tabs                    |
| Tests       | 13 unit + 35 integration + 25 isolation cases. **1159 API tests across 41 suites**; `pnpm typecheck`/`lint`/`test` all green         |
| Reviews     | Both run. 3 CRITICAL + 7 smaller, **all fixed**. See [CHANGELOG.md](CHANGELOG.md)                                                    |

### The decision PI-3 was required to make

**In-transit stock is held by the DOCUMENT, not by a bucket.** Dispatch writes
`TRANSFER_OUT` at the sender and nothing else; receipt writes `TRANSFER_IN` at
the receiver and nothing else. Neither side ever writes a row at the other's
branch, so no tenant context is ever widened.

This refines INVENTORY_ARCHITECTURE.md, which describes an `IN_TRANSIT` bucket
owned by the SENDING branch. That shape would make the RECEIVER write a removal
against a branch `stock_ledger.branch_isolation` hides from them — fixable only
by widening their context (the first hole in the branch boundary) or by writing
the row twice (the second ledger writer PI-ADR-004 forbids).

⚠️ **The cost, so PI-22 does not rediscover it:** in-transit stock is not in
`stock_balances`. A valuation report that sums that table and stops is
under-counting by whatever is on a van; it must add the outstanding lines of
`DISPATCHED` transfers. `verifyBalances()` is unaffected — both legs are ledger
rows. An integration test pins this.

### What the reviews found · all three CRITICALs were one class of mistake

1. **A duplicate `lineId` on receipt minted stock.** The loop measured every
   entry against a snapshot loaded once, so two entries naming one line both
   passed the over-receipt check and both wrote a leg. Ten sent became twenty
   received, and `verifyBalances()` agreed — both legs are real ledger rows.
2. **Every transfer state transition was a read-then-write race.** `withTenant`
   is plain READ COMMITTED. Worst pair is cancel-against-receive, which writes at
   two DIFFERENT branches so the engine's bucket locks never meet.
3. **The manual reservation release raced the sweep**, whose own implementation
   one package over documents in a comment exactly why that order is wrong.

Plus: a serial fitted to a patient between draft and dispatch was still
transferable (`assignSerial` writes no movement, so nothing downstream notices);
`toLineDetail` read the batch join rather than the line's snapshot; and five
smaller items. All fixed, with four regression tests.

### Two bugs the tests found that reading would not have

Both are the same shape and both are invisible from the code, because the query
is correct and the RLS policy is correct and they are correct about different
things:

1. **The receiving branch could not read its own delivery note.**
   `inventory_locations` is branch-scoped, so `fromLocation` came back NULL — not
   forbidden — and `toSummary` threw. Fixed by snapshotting the shelf NAMES onto
   the transfer (`..092000`), which is what a paper delivery note has always
   carried and is the more honest record besides.
2. **The receiving branch could not create its own lot row**, so receipt raised
   `Batch not found` while somebody held the boxes. `batches` is branch-scoped
   too. Fixed by snapshotting the lot's identity — number, dates, manufacturer,
   cost — onto the LINE (`..093000`).

Neither was fixed by weakening a policy. Both would have shipped.

### Deliberately NOT in PI-3

- **No `consumeReservation`.** Nothing consumes one: PI-7 and PI-9 move quantity
  out of `RESERVED` directly and will set `CONSUMED` in the same transaction.
  A state nothing can reach is a state nobody maintains; the enum member exists
  so neither phase needs a migration.
- **No adjustments TAB.** An adjustments list is the Movements list filtered to
  one type — the same rows, the same query. Recording one is an action, so it is
  a button on Movements.
- **Serial-tracked stock crossing a branch needs a dual-scoped receiver**, and is
  refused with a sentence otherwise. A serial IS the device, so receipt MOVES the
  record rather than copying it, and that record belongs to the sending branch
  until it does. The one cross-branch write in the flow.

---

# PI-4 — Procurement · COMPLETE (2026-08-13)

⚠️ The rows below read `NOT_STARTED` until PI-5 corrected them; the phase shipped
on `feat/pi-4-procurement` and the roll-up has said so since. See
[CHANGELOG.md](CHANGELOG.md) and NEXT_SESSION.md for what landed.

| Task    | Description                                                                           | Status       |
| ------- | ------------------------------------------------------------------------------------- | ------------ |
| PI-4.1  | `suppliers` + supplier tax identifiers                                                | **COMPLETE** |
| PI-4.2  | `supplier_products` — supplier SKU, pack size, price, lead time                       | **COMPLETE** |
| PI-4.3  | Purchase requisitions + approval                                                      | **COMPLETE** |
| PI-4.4  | Purchase orders + lines; `NumberSequenceType.PURCHASE_ORDER`                          | **COMPLETE** |
| PI-4.5  | Goods receipts + lines, with batch/serial capture; `NumberSequenceType.GOODS_RECEIPT` | **COMPLETE** |
| PI-4.6  | Quality / acceptance step; rejected stock → `QUARANTINED`                             | **COMPLETE** |
| PI-4.7  | Purchase returns                                                                      | **COMPLETE** |
| PI-4.8  | Costing: purchase cost, moving average, cost per base unit                            | **COMPLETE** |
| PI-4.9  | Screens: suppliers, PO workspace, GRN capture, returns                                | **COMPLETE** |
| PI-4.10 | Tests: receipt writes ledger; over-receipt refused; cost roll-up                      | **COMPLETE** |

---

# PI-5 — Global Regulatory Framework · COMPLETE (2026-08-13)

**Dependencies:** PI-1. **Priority:** P0 — PI-6 and every later rule pack sit on it.
**Branch:** `feat/pi-5-regulatory-framework`.

| Task   | Description                                                                                   | Status       |
| ------ | --------------------------------------------------------------------------------------------- | ------------ |
| PI-5.1 | `jurisdictions`, `regulatory_authorities`                                                     | **COMPLETE** |
| PI-5.2 | `regulatory_rules` + `regulatory_rule_packs`, versioned and effective-dated (PI-ADR-008)      | **COMPLETE** |
| PI-5.3 | `regulatory_sources` — the source registry                                                    | **COMPLETE** |
| PI-5.4 | `product_regulatory_profiles` — one product, many jurisdictions                               | **COMPLETE** |
| PI-5.5 | `@rcln/regulatory` — the pure evaluation package (PI-ADR-007)                                 | **COMPLETE** |
| PI-5.6 | Rule-pack maturity states + the "not compliance" banner (PI-ADR-009)                          | **COMPLETE** |
| PI-5.7 | New permission codes `regulatory.*`                                                           | **COMPLETE** |
| PI-5.8 | Screens: jurisdictions, authorities, product regulatory profile, rule status/version, sources | **COMPLETE** |
| PI-5.9 | Tests: rule resolution by date; region beats country; **no rule → refuse, never permit**      | **COMPLETE** |

| Area        | What landed                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `regulatory.prisma` — 6 tables, 8 enums. Five are PLATFORM (no `organization_id`); `product_regulatory_profiles` is platform-extensible tenant data |
| Migration   | `20260818090000_regulatory_framework` — NULLS NOT DISTINCT, 5 CHECKs, 2 trigger functions, grants                                                   |
| RLS         | `db:rls:check` green at **89** (was 88). The five platform tables are EXEMPT with the `tax_rule_defaults` reasoning, and guarded by a trigger       |
| Package     | **`@rcln/regulatory`** — `evaluate()`, pure, no Prisma, no clock. 43 unit tests                                                                     |
| Permissions | `regulatory.rule.read` / `.manage`, `regulatory.pack.approve`, `product.regulatory.read` / `.manage`                                                |
| Contracts   | `packages/contracts/src/regulatory.ts`                                                                                                              |
| Services    | `services/regulatory/` (catalogue, profile, evaluation, shared) · `services/platform/regulatory.service.ts`                                         |
| Routes      | `/v1/regulatory/{jurisdictions,authorities,sources,rule-packs,rules,evaluate}` · `/v1/platform/regulatory/*` · product regulatory profiles          |
| Web         | `/regulatory` — Places, Regulators, Rule packs (+ detail), Sources; the maturity rail; a Regulatory tab on the product; "Rules" nav entry           |
| Tests       | 43 package unit · 16 integration · 13 isolation. **Isolation suite at 307 across 15 files**; every API slice green                                  |

### The four decisions PI-5 was required to make

**1. The law is platform data with NO RLS policy, and a trigger is what protects it.**
`jurisdictions`, `regulatory_authorities`, `regulatory_sources`,
`regulatory_rule_packs` and `regulatory_rules` have no `organization_id` — the same
argument `tax_rule_defaults` already carries, with the same fail-closed
consequence if it were scoped: every tenant reads them inside its OWN transaction,
so a policy returns zero rows for everybody, no rule matches, and every decision
is `UNDETERMINED` — which refuses. Nobody could dispense anywhere.

⚠️ **`@rcln/db/unsafe` IS NOT AN OWNER CONNECTION** — it is `rcln_app` with no
session variables — so a SELECT-only grant would have locked the platform console
out too. `platform_law_not_tenant_writable` refuses any INSERT/UPDATE/DELETE from
a transaction that claims a tenant, which is the same discriminator
`refuse_platform_row_mutation` uses.

**2. `UNDETERMINED` refuses, and PI-5 wires it into NOTHING.** With no pack
configured anywhere, every evaluation is `UNDETERMINED`; calling `evaluateFor`
from the goods-receipt path today would stop every clinic on the platform from
receiving stock. PI-5 ships the engine, the data and `POST /v1/regulatory/evaluate`
— PI-6 wires the call sites as it reaches `RULES_IMPLEMENTED`.

**3. `REGULATORY_REVIEWED` is an eighth maturity, which PI-ADR-009's chain does
not draw.** That ADR's own prohibition names it, and reviewing content and
deciding to act on it are two events. Collapsing them makes review and rollout one
button. Recorded as a deliberate refinement, like PI-2's `EXPIRY`-is-a-MOVE and
PI-3's document-held in-transit.

**4. A rule may only name a PLATFORM product category.** `regulatory_rules` has no
policy to AND a `*_visible` one with, so a rule pointing at a clinic's private
category would leak that category's name to every other clinic through the rule
screen's join. Refused upstream by `regulatory_rule_category_is_platform`.

### Deliberately NOT in PI-5

- **`regulatory_decisions` — the decision snapshot table — is not built.**
  PI-ADR-008 requires every dispensing and consumption transaction to snapshot the
  decision that produced it, and neither transaction exists yet (PI-7, PI-9 are
  blocked on `prescriptions` and `encounters`). The DECISION already carries
  everything the snapshot needs — `packVersionIds`, the reasons, the conditions,
  the lowest maturity — so the table lands with its first writer rather than as a
  polymorphic guess about a subject that does not exist.
- **No country's rules.** PI-6 onwards, each cited to a source somebody checked.
- **The platform console has no SCREENS.** The endpoints are complete and tested;
  the admin UI for them is PI-6's, alongside the first pack somebody actually has
  to enter.

### The reviews

Both run, every finding fixed. `security-reviewer`: **no CRITICAL, no HIGH** — the
exemption argument for the five policy-less platform tables was attacked directly
and held. One MEDIUM: a signed-off pack's DATES were editable, and `loadRules`
filters on exactly that window, so a `{ "effectiveTo": … }` PATCH took every rule
in a reviewed pack out of force platform-wide.

`code-reviewer`: **four CRITICALs.** Three were one mistake — a parameters
document that omitted its rule type's essential key read as PERMISSIVE, so
`{ "require": true }` (one typo) made a prescription-only medicine general-sale,
and because a regional rule supersedes the national one of its type, it took the
rule that would have refused with it. The fourth was PI-4's lesson verbatim:
`createRule` read the pack it decided against and wrote to a different table with
no lock.

⚠️ **The concurrency test took three attempts and the first two passed with the
lock removed.** See [NEXT_SESSION.md](NEXT_SESSION.md) decision 6 — it is the
part of this phase most likely to be repeated.

Full detail in [CHANGELOG.md](CHANGELOG.md).

### Still open

- **Nothing has been clicked in a browser.** The same item PI-1 through PI-4 each
  left, now across five more screens.
- **`regulatory.pack.approve` is held by nobody.** That is correct and
  deliberate (OD-5), and it means PI-6 cannot reach `PRODUCTION_ENABLED` for India
  until a named person is granted it.
- **`RegulatoryActor.roleCodes` carries PERMISSION codes.** Documented rather than
  renamed, because `permittedRoleCodes` is the parameter key a pack is written
  against — PI-6 should rename both before the first pack exists.

---

# PI-6 — India Rule Pack · COMPLETE

**Dependencies:** PI-5. **Branch:** `feat/pi-6-india-rule-pack`. **Pack:**
`IN 1.0.0` at `AUTOMATED_TESTED` — 2 authorities, 3 sources, 22 rules.

| Task                                                                         | Status                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| PI-6.1 Research + populate `regulatory_sources` with authoritative citations | COMPLETE                                                            |
| PI-6.2 Prescription classification and schedule handling                     | COMPLETE                                                            |
| PI-6.3 Quantity, refill and record-retention rules                           | COMPLETE — retention + refills; no quantity limit exists to write   |
| PI-6.4 Labelling fields; online dispensing position                          | COMPLETE — labelling written; online position is `UNKNOWN`, no rule |
| PI-6.5 Per-rule tests (behaviour, never `country === 'IN'`)                  | COMPLETE — 20 integration + 12 unit                                 |
| PI-6.6 Update `COUNTRY_SUPPORT_MATRIX.md`; set maturity                      | COMPLETE — set to `RULES_IMPLEMENTED`, not `AUTOMATED_TESTED`       |
| **PI-6.7 Wire goods receipt and transfer to consult the pack**               | **NOT_STARTED — the one thing left**                                |

### What landed

| Area    | What                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sources | CDSCO's consolidated Drugs Rules, 1945 (963 pp, read directly) · Pharmacy Act, 1948 on India Code · G.S.R. 588(E) recorded `UNAVAILABLE`                                        |
| Rules   | 22 — prescription (H/H1/X), repeats, substitution, H1 + X registers, retention 3y/2y/2y, Schedule X storage, dispenser authority, dispensing + container + veterinary labelling |
| Seed    | `seed/regulatory-packs.ts` (machinery, no country) + `seed/data/regulatory-in.ts` (the pack). A new jurisdiction is a data file plus one line                                   |
| Engine  | **Closed a fail-open**: an unclassified medicine came back `PERMITTED_WITH_CONDITIONS` once a pack carried catch-all rules. Now `UNDETERMINED`                                  |
| Service | **Fixed**: `evaluateFor` ignored `inventory_locations.requires_controlled_access`, reading controlled access from the storage profile alone                                     |

### PI-6.7 — the call sites, and the gate that stops them breaking everything

Goods receipt (`STOCK`, before the batch exists and before the ledger moves) and
transfer receipt (`TRANSFER`, against the DESTINATION location) both consult the
engine inside their own posting transaction, through
`services/regulatory/consult.ts`. Neither contains a country, a rule code or a
schedule.

⚠️ **THEY ASK, AND NOTHING STOPS THEM YET.** One country has a pack, so nearly
every evaluation on the platform answers `UNDETERMINED` — which refuses — and a
call site that threw on a non-permission would stop every clinic elsewhere from
receiving stock the day it shipped. `services/regulatory/enforcement.ts` gates
it: a decision may only stop a document once a named human has moved its pack to
`PRODUCTION_ENABLED`, which no code path may set. Below that the answer is logged
where an operator can see it, with rule codes and ids and no PHI.

The integration suite pins both halves — six maturities that must NOT block, and
`PRODUCTION_ENABLED` that must — plus the unconfigured-jurisdiction case, which
is the one that would have broken the platform.

`evaluateWithin(tx, …)` was split out of `evaluateFor` for this: a second
transaction could not see the caller's uncommitted work, would take its own
snapshot, and can deadlock against locks the outer one holds.

### What is still open on India

- The pack is `AUTOMATED_TESTED` and enforces nothing. `SOURCE_VERIFIED` needs
  every citation re-checked; the two rungs above it are a named human's.
- KNOWN_ISSUES #3 and #4 — a prescriber-endorsed repeat and the Pharmacy Act
  s. 42 proviso cannot be expressed. Both are framework gaps to close before
  PI-7 wires dispensing, never by weakening a rule.
- KNOWN_ISSUES #5 — a stock movement evaluates with an EMPTY actor, because
  neither service is given the caller's permission codes.
- Most of India's matrix cells are still `RESEARCH_REQUIRED`, each for a recorded
  reason. NDPS is the big one.

---

# PI-7 — Pharmacy Dispensing · COMPLETE (2026-08-16)

**Dependencies:** PI-1..PI-5 + `encounter_prescriptions` (CE-4).
**Branch:** `feat/pi-7-pharmacy-dispensing`.
**Migration:** `20260825090000_pharmacy_dispensing` — 8 tables, 12 CHECKs, the
append-only pair on the snapshot, and 14 RLS policies.

| Task                                                              | Status                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| PI-7.0 Close the two framework gaps PI-6 recorded                 | COMPLETE — KNOWN_ISSUES #3 and #4, closed in `@rcln/regulatory` |
| PI-7.1 `regulatory_decisions` — the PI-ADR-008 snapshot           | COMPLETE — append-only, branch-scoped, first written here       |
| PI-7.2 Dispensing schema + RLS + isolation cases                  | COMPLETE — 7 tenant tables, 13 isolation cases                  |
| PI-7.3 `pharmacy.dispense.verify` and the role grant              | COMPLETE — `PHARMACIST` holds it beside `.create`               |
| PI-7.4 Contracts — queue, prescription, supply, return, dashboard | COMPLETE — `packages/contracts/src/pharmacy.ts`                 |
| PI-7.5 The queue, verification and the prescription read          | COMPLETE — every read logs one `data_access_logs` row           |
| PI-7.6 The supply: FEFO, the law, the ledger, the number          | COMPLETE — one transaction, no draft                            |
| PI-7.7 Returns, disposition and the counter sale                  | COMPLETE — quarantine is the default                            |
| PI-7.8 Substitution — equivalents with the legal answer attached  | COMPLETE (read-only screen; supplying one is API-only)          |
| PI-7.9 Screens — dashboard, queue, prescription, workspace, …     | COMPLETE — 7 screens                                            |
| PI-7.10 Tests — unit, integration, isolation                      | COMPLETE — 12 unit · 24 integration · 13 isolation              |

### Completion gate

`DB` migration + RLS + isolation ✓ · `BE` every service through `withTenant` ✓ ·
`API` contracts + routes + the standard chain ✓ · `FE` 7 screens ✓ · `VAL` Zod
on every surface ✓ · `AUTHZ` four codes, one new ✓ · `AUDIT` `recordAudit` on
every write and `recordDataAccess` on every read ✓ · `REG` the engine is asked
inside the posting transaction and the answer is snapshotted ✓ · `TEST` ✓ ·
`DOC` this directory ✓ · `REGRESS` lint, typecheck, 1 262 tests and
`db:rls:check` at 118 tables, all green ✓.

### What landed

| Area     | What                                                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema   | `dispenses`, `dispense_lines`, `dispense_allocations`, `dispense_returns`, `dispense_return_lines`, `prescription_fulfilments`, `regulatory_decisions`                                                         |
| Engine   | `repeatsAuthorised` + `repeatsAuthorisedLimit` on the prescription; `isPrescriber` on the actor; `endorsedRepeatsPermitted` / `maxEndorsedRepeats` / `exemptWhenActorIsPrescriber` as rule parameters          |
| India    | Both clauses now expressible — rule 65(11)(b)'s endorsed repeat and s. 42(1)'s own proviso. **Neither rule was weakened**; the parameters were added in the one window where no decision had ever cited a rule |
| Services | `pharmacy/{shared,consult,queue,dispense,return,substitution,dashboard}.service.ts`                                                                                                                            |
| Seam     | `planStockAllocationWithin(tx, …)` split out of `planStockAllocation`, for the reason `evaluateWithin` was split out of `evaluateFor`                                                                          |
| Errors   | `RegulatoryRefusalError` — 422 with the rule's own sentence, never a 403                                                                                                                                       |
| Screens  | Dashboard · queue · prescription · **dispensing workspace** · equivalents · dispensed list · dispense detail with returns · counter sale                                                                       |

### The three things worth reading before changing any of it

**A dispense has no draft.** The medicine leaves the shelf once, so the workspace
assembles a plan (which writes nothing), a human confirms it, and ONE transaction
writes the record, the ledger legs, the snapshot, the audit row and the queue
state. The number is taken after every line has been consulted, so a refusal
burns none — `leaves nothing behind, and burns no number` is the case.

**The law is asked before the stock moves, and the answer is frozen.** Every
supplied line carries a NOT NULL `regulatory_decision_id`; `regulatory_decisions`
is append-only in two layers. Nothing re-evaluates a historical supply, ever.
Enforcement is still gated at `PRODUCTION_ENABLED`, so today the decisions are
recorded and reported and stop nothing — which is the correct state, not a
disabled feature.

**Invariant 7 is enforced at the router.** `route-gates.test.ts` now audits the
pharmacy router and asserts no route on it carries a `clinical.*` code. Pharmacy
writes `prescription_fulfilments` — its own state beside the consultation — and
the fulfilment arithmetic is DERIVED from `dispense_lines` rather than stored on
the clinical row.

### What is open, and honestly so

- **Nothing has been clicked in a browser.** The same item every phase has left.
- **An endorsed repeat still refuses**, because `encounter_prescriptions` has no
  field in which a prescriber can endorse one. The FRAMEWORK gap is closed and
  the clinical one is not; the plug-in point is marked in `dispense.service.ts`.
- **`licenceTypes` is always empty**, so a rule naming a professional
  registration resolves `UNDETERMINED`. Latent: nothing enforces yet.
- **`priorQuantityInPeriodBase` is never supplied**, so a `QUANTITY_LIMIT` with a
  period resolves `UNDETERMINED` rather than counting. Latent for the same reason.
- **Supplying a substitute is API-only.** The equivalents screen shows what the
  law says; swapping the product is not wired into the workspace.
- **The dashboard's "today" is a UTC day**, not the branch's. Counts only.
- **No charge request.** Pharmacy owns no money and PI-8 is where a supply
  reaches an invoice.

**Completion date:** 2026-08-16 · **Next action:** PI-8.1
