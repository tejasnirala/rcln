# Implementation Tracker

**The authority on task state.** Update it as you work, not at the end.

**Last updated:** 2026-08-20 (PI-17 complete — the two Emirati rule packs)

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

| Phase     | Title                                          | Status                    | Blocked by                               |
| --------- | ---------------------------------------------- | ------------------------- | ---------------------------------------- |
| PI-0      | Discovery & Architecture                       | **COMPLETE** (2026-08-11) | —                                        |
| PI-1      | Product Platform Core                          | **COMPLETE** (2026-08-11) | —                                        |
| PI-2      | Inventory Foundation                           | **COMPLETE** (2026-08-12) | —                                        |
| PI-3      | Movements                                      | **COMPLETE** (2026-08-12) | —                                        |
| PI-4      | Procurement                                    | **COMPLETE** (2026-08-13) | —                                        |
| PI-5      | Global Regulatory Framework                    | **COMPLETE** (2026-08-13) | —                                        |
| PI-6      | India Rule Pack                                | **COMPLETE** (2026-08-13) | —                                        |
| PI-7      | Pharmacy Dispensing                            | **COMPLETE** (2026-08-16) | —                                        |
| PI-8      | Billing & Tax Integration                      | **COMPLETE** (2026-08-17) | — reviews run 2026-08-17, findings fixed |
| PI-9      | Clinical Consumption                           | **COMPLETE** (2026-08-17) | —                                        |
| PI-10     | Recall & Traceability                          | **COMPLETE** (2026-08-18) | —                                        |
| PI-11     | Veterinary Enablement                          | **COMPLETE** (2026-08-19) | —                                        |
| PI-12     | Online Pharmacy                                | **COMPLETE** (2026-08-19) | — ⚠️ not reviewed                        |
| PI-13a    | Rule-pack framework extensions (survey-sized)  | **COMPLETE** (2026-08-19) | — ⚠️ not reviewed                        |
| PI-13     | United States Rule Pack (federal + California) | **COMPLETE** (2026-08-19) | — ⚠️ not reviewed                        |
| PI-14     | United Kingdom Rule Pack                       | **BLOCKED**               | legislation.gov.uk returns 202           |
| PI-15     | Australia Rule Pack (national + Victoria)      | **COMPLETE** (2026-08-20) | — ⚠️ not reviewed                        |
| PI-16     | Singapore Rule Pack                            | **COMPLETE** (2026-08-20) | — ⚠️ not reviewed                        |
| PI-17     | UAE Rule Packs (Abu Dhabi + Dubai)             | **COMPLETE** (2026-08-20) | — ⚠️ not reviewed; no federal pack       |
| PI-18     | Ireland Rule Pack                              | **COMPLETE** (2026-08-20) | — ⚠️ not reviewed                        |
| PI-19..21 | Country Rule Packs (NP, LK, BD)                | NOT_STARTED               | —                                        |
| PI-22     | Reporting & Cost Accounting                    | NOT_STARTED               | PI-4                                     |
| PI-23     | Identifier Resolution / Barcode                | NOT_STARTED               | PI-1, PI-2                               |
| PI-24     | Global Hardening                               | NOT_STARTED               | everything                               |

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

### The gap that was found after the phase was first called done

⚠️ **A PRICE COULD NOT BE SET FROM ANY SCREEN, AND THE CODE COMMENTED AS THOUGH
IT COULD.** `saveProductPriceAction` was written and wired to nothing;
`product-price-list.tsx` listed and deleted; the product panel had no pricing
tab. So `PUT /v1/charging/prices` was reachable only by API, every charge request
came out with a NULL `unit_price`, and the charge queue's gap rail lit up on
every row with no control anywhere that closed it. The whole phase was unusable
end to end from a browser.

Worse than the omission: `product-price-list.tsx`'s header ASSERTED that a price
is set from the product screen — "that is where somebody already has the item,
its base unit and its packaging in front of them" — as though the control
existed. The reasoning was right and is the shape that was built; what was wrong
was a comment describing code nobody had written.

**Closed:** a `Price` tab on the product panel, before `Tax`, with a unit picker
whose options the API validates against the product's own conversion graph. The
empty state says out loud that an unpriced product still dispenses and simply
never reaches an invoice, because that consequence is otherwise invisible until
month end.

Recorded rather than quietly fixed, because the failure mode — a comment that
documents an intention as though it were an implementation — is worth being able
to recognise again.

### Three more gaps closed in the same pass

- **Per-line crediting reached the screen.** The invoice detail could only
  reverse a whole bill; the API took a per-line set from the start. A partial
  return is the ordinary case, so the credit dialog now carries a line picker
  seeded with the full invoice.
- **KNOWN_ISSUES #1** — `stock_transfer_lines` rendered in a nondeterministic
  order. `createMany` gives every line of one document the same `created_at`, so
  `orderBy: { createdAt: 'asc' }` is not a total order. The entry asked for the
  `{ id: 'asc' }` tie-break "in the next session that touches transfers"; PI-8
  touched `transfer.service.ts`, so it was taken.
- **KNOWN_ISSUES #12** — the pharmacy dashboard counted "today" as a UTC day.
  Now `date_trunc('day', now() AT TIME ZONE b.timezone)`, resolved in SQL from
  `branches.timezone` the way `inventory_branches_with_expired_stock` does it.
  Invariant 6.

### The reviews, and the finding worth remembering

Both reviewers ran. **Three CRITICALs, two HIGHs and about a dozen smaller, all
fixed** — the detail is in [CHANGELOG.md](CHANGELOG.md).

⚠️ **THE ONE TO REMEMBER: PI-8'S OWN SUBSTITUTION UI WIDENED A HOLE PI-8 HAD LEFT
OPEN.** This phase went in specifically to close the KI-3 class on
`dispense_lines` and closed `product_id` — while `substituted_for_product_id`,
the column immediately below it, is a second plain FK into `products`, taken
straight from the client, unvalidated, and joined for its name onto the dispense
detail screen. Then PI-8.12 added the picker that makes it reachable from a
browser. The model comment says "plain FK**s**", plural, describing a policy set
that covered one of them.

The other four: a credit note refunded GROSS where the patient paid NET, and its
ceiling compared three different bases; `createCreditNote` skipped the visibility
check every other invoice mutation makes; `raiseChargeRequestsWithin` could throw
and block a pharmacist mid-supply, which is the one thing its header promises it
cannot do; and a substituted line sent a quantity in the prescribed product's
base unit paired with the substitute's unit id.

### ⚠️ WHAT WAS DELIBERATELY NOT TAKEN (superseded — see above)

**This section is kept for the reasoning, not the status.** Hardening is now
done. `/code-review` and
`security-reviewer` have NOT been run — the owner is running both manually. This
diff touches the schema, tenancy, auth, permissions, patient data, billing and
raw SQL, so CLAUDE.md makes the security review mandatory before merge. It is not
a formality: PI-1's review found two CRITICALs, PI-3's three and PI-5's four, and
in each case they were one class of mistake repeated.

Point a reviewer at these first, because they are where this phase took its
risks: `lockCharges`' ordered `FOR UPDATE` (the PI-3 read-then-write class),
`assertWithinRemaining`'s deliberately loose ceiling, `raiseChargeRequestsWithin`
running inside the dispense transaction, and the two new `*_visible` policy
pairs.

### KNOWN_ISSUES #10 and #11, closed in a second pass

**#10 — the quantity window, turned into a lookup.** The window a
`QUANTITY_LIMIT` measures over is `periodDays` on the RULE, so a caller cannot
know it until after evaluation, and the engine is pure by design (PI-ADR-007) so
it cannot look the history up itself. `EvaluationSupplements.priorQuantityInPeriod`
inverts the direction: `evaluateWithin` selects the applicable rules with the
engine's own `selectApplicableRules`, reads the window off them, and calls back
into the caller who knows who the supply is for. The engine still holds no Prisma
client.

⚠️ **Two rules with different windows still resolve `UNDETERMINED`, deliberately.**
`RegulatoryRequest` carries ONE `priorQuantityInPeriodBase`. The longer window
over-counts for the shorter rule and refuses lawful supplies; the shorter one
UNDER-counts for the longer rule and PERMITS what the law forbids, which is the
direction this domain may never fail in. So it refuses, exactly as before, and
the single-window case — every real pack — is now answered.

⚠️ **A counter sale with no patient also stays `UNDETERMINED`.** There is no
history to sum, and reading that as zero would let anyone take the limit again on
every visit, which is the pattern a quantity limit exists to stop.

**#11 — supplying a substitute.** The workspace gained a "Hand over" picker per
line, fed by equivalents fetched on the SERVER alongside the plans, each option
labelled with what the engine said about substituting THAT product HERE — in the
option text, because a badge beside a dropdown is a badge nobody reads — plus a
required reason and the narrow-therapeutic-index warning.

⚠️ **THE LOAD-BEARING PART IS THAT A SUBSTITUTED LINE SENDS NO ALLOCATIONS.** The
lots on that screen were planned for the PRESCRIBED product and are meaningless
for the substitute; omitting them is the contract's own "you plan it", so the
server runs `planStockAllocationWithin` against the product actually being
supplied. Sending the prescribed product's lots would take stock off the wrong
shelf while recording the substitute's name — invisible from the screen that
caused it, and pinned by a test. `substitutionCandidate` gained `baseUnitId` for
the same class of reason.

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

**Completion date:** 2026-08-16 · **Next action:** PI-8.1 — done, see below

---

# PI-8 — Billing & Tax Integration · COMPLETE (2026-08-17)

**Dependencies:** PI-1..PI-7. **Branch:** `feat/pi-8-billing-tax-integration`.
**Migration:** `20260901090000_billing_tax_integration` — 4 tables, 10 CHECKs,
2 partial uniques, 13 RLS policies and the credit-note columns on `invoices`.

| Task                                                            | Status                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| PI-8.0 Close the three PI-7 leftovers                           | COMPLETE — KNOWN_ISSUES #5, #8 and #9                                 |
| PI-8.1 `charge_requests` — the structured hand-off              | COMPLETE — written in the dispense's own transaction                  |
| PI-8.2 Charge-policy resolution, with the answer snapshotted    | COMPLETE — 3 of the 8 tiers; the rest name entities that do not exist |
| PI-8.3 `product_prices` — what a clinic sells for               | COMPLETE — branch override beats org default, priced per unit         |
| PI-8.4 Wire `InvoiceSourceType.PHARMACY` end to end             | COMPLETE — `POST /v1/invoices/from-charges`                           |
| PI-8.5 Wire `.INVENTORY`                                        | ENGINE COMPLETE, no writer — PI-9's consumption is the caller         |
| PI-8.6 Product → jurisdiction → `tax_category` resolution       | COMPLETE — through `resolveTaxCategory`, no tax logic written         |
| PI-8.7 **The credit-note engine**                               | COMPLETE — an `invoices` row with its own `CRN-` series               |
| PI-8.8 Returns: cancel an unbilled charge, credit a billed one  | COMPLETE                                                              |
| PI-8.9 Screens — the charge queue, prices, policy, credit notes | COMPLETE — 3 screens plus the invoice detail                          |
| PI-8.10 Tests — unit, integration, isolation                    | COMPLETE — 16 unit · 25 integration · 13 isolation                    |

### Completion gate

`DB` migration + RLS + isolation ✓ · `BE` every service through `withTenant` ✓ ·
`API` contracts + routes + the standard chain ✓ · `FE` 4 screens + the Price tab
✓ · `VAL` Zod on every surface ✓ · `AUTHZ` three new codes ✓ · `AUDIT`
`recordAudit` on every write, `recordDataAccess` on the queue read ✓ · `REG` n/a
— charging is a commercial decision, not a legal one; the law was consulted at
the supply · `TEST` ✓ · `DOC` this directory ✓ · `REGRESS` lint, typecheck,
**227 unit · 404 isolation · 1 015 integration** and `db:rls:check` at 121
tables, all green ✓. **227 unit · 631 unit+isolation · 1 026 integration.**

### The four decisions PI-8 was required to make

**1. A credit note is an `invoices` row with a different `kind`, not a parallel
set of tables.** The alternative duplicates the line arithmetic, the
apportionment, the per-line tax snapshot, the document join and — the part that
decides it — `invoices_lifecycle_guard`, the trigger that freezes an issued
document's every money column. A credit note has exactly the same immutability
requirement, so it gets exactly the same trigger by being the same table. What
the law actually requires is a separate consecutive SERIES, and that is a period
key: `CRN-2026-PHA-MAIN-000001`. One table, two series.

**2. The precedence chain is three tiers, not eight.**
BILLING_INTEGRATION.md lists eight, five of which name a `procedure` or a
`payer`. Procedures are PI-9, blocked on `encounters`; there is no payer-contract
model anywhere. `CONTRACT_DEFINED` and `JURISDICTION_CONFIGURED` are real enum
members that resolve to a human decision, exactly as `OPTIONAL` does — kept
distinct because the REASON the desk is being asked differs, and because it is
their call sites that change when the engines land.

**3. ⚠️ THE LINK BACK IS `invoice_id`, NOT `invoice_item_id`, WHICH CORRECTS THE
DESIGN DOCUMENT.** BILLING_INTEGRATION.md says "`charge_requests.invoice_item_id`
is the only link back". `finalizeInvoice` re-prices a draft from its stored
inputs, and it does that by DELETING every `invoice_items` row and writing them
again — so an item id changes at least once between the draft being raised and
the document being issued. Measured, not reasoned about: the first version had
the FK and finalisation raised
`charge_requests_organization_id_invoice_item_id_fkey`. The invoice id is stable
for the life of the document and is what every question is actually about.

**4. A charge request is written in the supply's transaction and can never stop
it.** Those two requirements are in tension and are resolved in one direction:
every configuration gap is a NULLABLE COLUMN rather than an error. No price →
`unit_price IS NULL`. No tax classification → `tax_category IS NULL`. Both show
on the charge-review screen; the invoice engine refuses to ISSUE an unrated line
anyway, which is the right place for that refusal because by then nobody is
standing at a counter waiting.

### What landed

| Area        | What                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `charge_policy_rules`, `product_prices`, `charge_requests`, `membership_professional_registrations`; `invoices.kind` + `.credited_invoice_id`               |
| Clinical    | `encounter_prescriptions.repeats_authorised` + `.repeats_authorised_limit` — the endorsement the engine has been able to read since PI-7 and nothing wrote  |
| RLS         | `db:rls:check` green at **121** (was 118). ⚠️ Two tenancy classes: `charge_policy_rules` is org-only; `product_prices.branch_id` is NULLABLE and live       |
| Permissions | `billing.charge_request.read` / `.manage`, `billing.charge_policy.manage`. Pricing reuses `billing.fee_schedule.manage`; credit notes use the seeded code   |
| Contracts   | `packages/contracts/src/charging.ts`; `invoiceKind`, the credit-note request and `creditNotes` on `InvoiceDetail`                                           |
| Services    | `services/charging/{policy,price,charge-request}.service.ts` · `services/invoicing/{charge-billing,credit-note}.service.ts` · `regulatory/actor.service.ts` |
| Routes      | `/v1/charging/{requests,policies,prices}` · `POST /v1/invoices/from-charges` · `POST /v1/invoices/:id/credit-notes`                                         |
| Web         | `/charges` (queue, prices, policy) plus the credit-note action and the credited panel on the invoice detail; a "Charges" nav entry                          |

### Three gaps this phase found in earlier work and closed

1. **`dispense_lines` had no `product_visible` or `unit_visible` policy** — the
   KI-3 class, on the most PHI-dense table in the programme.
   `encounter_prescriptions` has carried one since CE-4 for the same plain FK
   into the same platform-extensible table, which is what makes PI-7's omission
   an oversight rather than a decision.
2. **`regulatory_decisions`' append-only REVOKE was undone by every reset.** The
   migration revokes UPDATE and DELETE; `ALTER DEFAULT PRIVILEGES` re-grants them
   on the next `db:reset`, and the isolation case that checks for it only fails
   AFTER a reset — which is why PI-7 shipped green. Now restated in
   `grant-app.sql`, where every other append-only table already was.
3. **`tests/.../inventory.test.ts` was not idempotent against a crashed run**, so
   a suite that died early left a `users` row behind and every later run failed
   on `users_email_key` with an error about a duplicate email.

### What is open, and honestly so

- **Nothing has been clicked in a browser.** The same item every phase has left,
  now across three more screens.
- **`INVENTORY` charge requests have no writer.** The engine handles them; the
  caller is PI-9's clinical consumption, which is blocked on `encounters`.
- **`CONTRACT_DEFINED` and `JURISDICTION_CONFIGURED` stop at a human**, because
  neither engine exists. Recorded as accepted debt.
- **The category tier walks no ancestry.** A rule on "Antibiotics" does not reach
  a product filed under its child "Penicillins" — stated in the resolver, because
  the opposite is the natural assumption.
- **A credit note moves no money.** There is still no patient-payments table, so
  `amount_paid` is always zero and the refund itself is unimplemented. That is
  `voidInvoice`'s honest boundary moved one step forward, not papered over.
- **The invoice-detail credit action reverses the whole bill.** The API takes a
  per-line set; choosing quantities off a frozen document belongs to the returns
  flow, which knows what actually came back.

**Next action:** PI-8.11 hardening — `/code-review` and `security-reviewer`, run
manually. Neither PI-10 nor PI-12 should start before the security review of this
diff lands.

---

# PI-8.11 — Hardening · COMPLETE (2026-08-17)

The review gate `NEXT_SESSION.md` said had to land before anything else started.
Run over `main...HEAD` — the whole unreviewed PI-7 + PI-8 diff, 247 files.

| Check               | Result                                    |
| ------------------- | ----------------------------------------- |
| typecheck           | PASS — 29 tasks                           |
| lint                | PASS — 0 errors, 3 pre-existing warnings  |
| `db:rls:check`      | PASS — 121 tenant tables                  |
| unit                | **231** across 13 suites (+4 new)         |
| tenant-isolation    | **410** across 23 suites                  |
| integration         | **1 077** across 48 suites (+5 new)       |
| `security-reviewer` | 1 HIGH, 2 MEDIUM, 3 LOW — **no CRITICAL** |
| `code-reviewer`     | **1 CRITICAL**, 2 HIGH, 5 WARNING, 5 NIT  |

### The CRITICAL, and why it is the one to remember

**A dispense line could supply a different product from the one prescribed
without declaring a substitution.** Every substitution control in the programme
hangs off `substitutedForProductId`: both contract refinements are conditioned on
it being set, and `consultForSupply` is told `substitution: { isSubstitution: true }`
only when it is set. So omitting it meant no mandatory reason, no
`SUBSTITUTION_RESTRICTION` rule ever fired, and the frozen
`regulatory_decision_id` recorded a PERMITTED supply for a question nobody asked.
The stored row then read `substituted_for_product_id = NULL` — asserting the
substitute IS what the prescriber wrote — and `refreshFulfilment` closed the
prescription off, because it sums by prescription line without looking at the
product.

`prescriptionLine.productId` was selected and never compared to anything.

⚠️ **THE WEB WORKSPACE ALWAYS SENT THE FIELD, WHICH IS WHY THIS SURVIVED THE
PHASE.** A control that only the happy-path client applies is not a control. The
declaration is now DERIVED from the two products disagreeing, never trusted.

### The rest, all fixed

1. **[HIGH] Duplicate `invoiceItemId` defeated the per-line credit cap.**
   `alreadyCreditedByItem` is snapshotted once before the loop, so two entries
   naming one line both read the same untouched remainder. Split across two small
   quantities the total stays under `assertWithinRemaining` and commits — a
   statutory credit note reversing a quantity of one HSN that was never billed
   under it. `createInvoiceFromChargesRequest` had already answered the identical
   question with a `.refine()`; the credit note now has the same one.
2. **[HIGH] `unitPriceMinor` was a pricing power behind the charge code.** The
   contract argued it was safe because the default roles hold `invoice.create`
   too — true of the defaults and of nothing else, and `roles.ts` says in its own
   header that the defaults are "a default, not a ceiling". Now requires
   `billing.fee_schedule.manage` **in addition**, and only when a price is
   actually overridden.
3. **[HIGH] The return ceiling was a read-then-write with no lock.** The CHECK
   constraint stopped the corruption, so this was never a data defect — it was a
   Postgres 23514 reaching `errorHandler`, which has no case for a CHECK
   violation, so the loser got a 500 instead of "that already came back".
4. **[MEDIUM] A branch-scoped member could write the CLINIC-WIDE price.** RLS
   cannot catch it: the `branch_id IS NULL` half of `branch_isolation` is
   correctly load-bearing for reads and passes `WITH CHECK` too. ⚠️ And
   `deleteProductPrice` carried a comment reading "the org-wide one is covered by
   nothing, so it is checked here" directly above a line that checked the BRANCH
   row and skipped the org-wide one — **the inverse of what it promised**. The
   same failure mode PI-7 wrote up: a comment documenting an intention as though
   it were an implementation.
5. **[MEDIUM] `pharmacy.dispense.verify` reached ORG_OWNER and ORG_ADMIN.** Those
   are `ALL_PERMISSIONS.filter(...)` roles, so a code nobody was meant to have
   joins them silently unless named. Excluded through a new
   `PROFESSIONAL_ATTESTATION` list rather than by stretching `CLINICAL_AUTHORING`
   — verifying writes `prescription_fulfilments`, not the chart, which is exactly
   what keeps invariant 7 true at the router.
6. **[WARNING] Float money**, in a figure the same file computed correctly in
   `Prisma.Decimal` 150 lines later — so the queue header and the queue rows could
   disagree by a minor unit on one screen.
7. **[WARNING] Verifying could clobber a concurrent dispense's fulfilment state**,
   and the read-then-create raced the unique. Now locked, and an upsert.
8. **[LOW] Licence validity was evaluated on the UTC day**, contradicting
   invariant 6 and the model's own comment — for an IST clinic every supply
   between 00:00 and 05:30 local honoured a licence that expired yesterday. Now
   resolved in SQL from `branches.timezone`.
9. **[NIT] The workspace sent `'0'`** for a substituted line with no outstanding
   quantity, producing a 400 naming a quantity no control on the screen sets.

### What the reviews confirmed clean

All 11 new tenant tables carry policies in **both** `enable-rls.sql` and their
migration with no drift, and all 11 have isolation cases. The full plain-FK sweep
found **no missing member** of the `*_visible` class that produced a CRITICAL in
three separate phases — including `substituted_for_product_id`, which PI-8 closed.
`regulatory_decisions` is append-only in both layers. Six raw-SQL sites, all
parameterized. No `@rcln/db/unsafe`. IDOR and 404-not-403 correct on every new
route. PHI clean in logs, Redis and URLs. Middleware order correct on both routers.

⚠️ **THE RLS LAYER PASSED, WHICH IS THE FIRST TIME.** Every finding that survived
is application-layer authorization or a concurrency race — the two things no
automated check in this repository looks at.

### Still open

- **Nothing has been clicked in a browser.** Unchanged since PI-1.
- **`membership_professional_registrations` has no write path**, so
  `RegulatoryActor.licenceTypes` is `[]` for every real user and KNOWN_ISSUES #9
  is half closed: the column exists, nothing fills it. Latent — enforcement only
  bites at `PRODUCTION_ENABLED`.
- **`lockCharges` relies on a planner property, not a guarantee.** In practice
  PostgreSQL plans `ORDER BY id FOR UPDATE` as `LockRows → Sort → Scan` so the
  header's claim holds; it is a plan shape rather than a documented contract.
  Recorded, not changed.
- **The per-line loop in `createDispense` is a genuine N+1** inside the
  highest-contention transaction in the programme — ~5 round trips per line while
  holding advisory bucket locks. The product read alone is one `findMany`.
- **`explicit organizationId` is omitted on five product reads** where a sibling
  goes out of its way to include it. RLS is the only layer holding them.

---

# PI-9 — Clinical Consumption · COMPLETE (2026-08-17)

**Dependencies:** PI-1..PI-3 (product, inventory, movements) + `encounters` /
`encounter_procedures`, **all satisfied**. PI-8 supplies the charge engine.
**Design:** [CLINICAL_CONSUMPTION.md](CLINICAL_CONSUMPTION.md) — read it first;
it is the whole specification and it is unusually complete.

⚠️ **THE BLOCKER RECORDED AGAINST THIS PHASE SINCE PI-0 IS GONE.** `encounters`
and `encounter_procedures` landed with the consultation engine (`066a79c`), and
`EncounterProcedure` carries `@@index([organizationId, itemId, status])` annotated
"PI-9 reads this: what procedures were performed, and therefore what stock they
consumed". The roll-up said BLOCKED until 2026-08-17 because nobody had rechecked
it; STATUS.md line 47 had said "PI-9 is unblocked" for some time.

**Migration:** `20260908090000_clinical_consumption` — 5 tables, 3 enums, 9
CHECKs, 2 partial uniques, 13 RLS policies, plus `charge_requests.consumption_line_id`
and the `@@unique([organization_id, id])` `encounter_procedures` had always
needed. `..090500_data_access_resource_clinical_consumption` adds the enum value.

| Task    | Description                                                                          | Status                                                                      |
| ------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| PI-9.1  | `consumption_templates` + lines — org-scoped, versioned by effective date            | COMPLETE — the open-ended half is an index, the rest a check                |
| PI-9.2  | `clinical_consumptions` + `consumption_lines` — the anchor set, expected vs actual   | COMPLETE — 2 anchors built, 2 declared and refused                          |
| PI-9.3  | RLS on every new table + isolation cases + the `*_visible` sweep                     | COMPLETE — 5 tables, 5 `*_visible`, 19 isolation cases                      |
| PI-9.4  | `consumption.record` / `consumption.override` permission codes and role grants       | COMPLETE — four codes; see the note below on the other two                  |
| PI-9.5  | Contracts in `@rcln/contracts`                                                       | COMPLETE — `packages/contracts/src/consumption.ts`                          |
| PI-9.6  | The recording service — FEFO allocation, `CLINICAL_CONSUMPTION` ledger legs, serials | COMPLETE — one transaction, no draft                                        |
| PI-9.7  | **The `InventoryChargeRequest` writer** — PI-8 built the engine and left no caller   | COMPLETE — the caller PI-8 named                                            |
| PI-9.8  | Amend before close; compensating movement after                                      | COMPLETE — delta legs before, a second record after                         |
| PI-9.9  | Assigning a serial to a patient gets its screen at last (deferred here from PI-2)    | COMPLETE — the picker, and the two defects it uncovered                     |
| PI-9.10 | Screens — template editor, the consumption panel on the encounter/procedure          | COMPLETE — 3 screens plus the panel                                         |
| PI-9.11 | Tests — unit, integration, isolation                                                 | COMPLETE — 24 unit · 28 integration · 19 isolation, +2 pharmacy regressions |

### Completion gate

`DB` migration + RLS + isolation ✓ · `BE` every service through `withTenant` ✓ ·
`API` contracts + routes + the standard chain ✓ · `FE` 3 screens + the
consultation panel ✓ · `VAL` Zod on every surface ✓ · `AUTHZ` four codes, all
new ✓ · `AUDIT` `recordAudit` on every write and `recordDataAccess` on every read
including the PLAN ✓ · `REG` n/a — deliberately, and the reasoning is in the
service header: no rule type in PI-5 addresses ADMINISTERING a product, and
asking the engine would answer `UNDETERMINED` for every product on the platform,
which refuses · `TEST` ✓ · `DOC` this directory ✓ · `REGRESS` lint (0 errors),
typecheck, `db:rls:check` at **126** tables, **255 unit · 429 isolation · 1 067
integration** all green ✓.

### What landed

| Area        | What                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `consumption_templates`, `consumption_template_lines`, `clinical_consumptions`, `consumption_lines`, `consumption_allocations`                                    |
| Charging    | `charge_requests.consumption_line_id` — the column PI-8 said would arrive in the migration that creates its table. `raiseChargeRequestsWithin` gains `sourceType` |
| Clinical    | `encounter_procedures` gains `@@unique([organization_id, id])`, the composite-FK target ADR-0004 requires and nothing had needed until now                        |
| RLS         | `db:rls:check` green at **126** (was 121). ⚠️ Two tenancy classes: the two template tables are org-only, the three record tables are org + branch                 |
| Permissions | `consumption.record.read` / `.record` / `.override` / `.template.manage` — DOCTOR and NURSE get the first three, BRANCH_ADMIN the read and the templates          |
| Contracts   | `packages/contracts/src/consumption.ts`                                                                                                                           |
| Services    | `services/consumption/{shared,template,consumption}.service.ts`                                                                                                   |
| Routes      | `/v1/consumption/{templates,plan,records}`                                                                                                                        |
| Web         | `/usage` (used, templates, one template) plus the consumption panel on the consultation; a "Usage" nav entry                                                      |
| Tests       | `tests/unit/consumption-contract.test.ts` (24) · `tests/integration/consumption.test.ts` (24) · 19 isolation cases · `route-gates` audits the new router          |

### The four decisions PI-9 was required to make

**1. Two anchors are built and two are declared.** `ENCOUNTER` and
`ENCOUNTER_PROCEDURE` carry columns; `LAB_ORDER` and `IMAGING_STUDY` are enum
members with none, and `clinical_consumptions_anchor_is_resolvable` refuses them.
The member costs nothing and saves the lab phase an enum migration — the same
call PI-3 made with `StockReservationStatus.CONSUMED`. A polymorphic
`(subject_type, subject_id)` pair was refused for the reason the tracker
predicted: it cannot carry a composite FK, so the database cannot tenant-check
it, which is ADR-0006 wearing different clothes.

**2. ⚠️ THE LAW IS NOT ASKED, AND THAT IS A DECISION RATHER THAN AN OMISSION.**
`@rcln/regulatory` answers questions about SUPPLYING a product to a person — may
this be dispensed, may it be substituted, was a prescription presented. A
clinician using an anaesthetic on their own patient during a procedure they are
performing is not a supply, no rule type in PI-5 addresses it, and calling
`evaluateWithin` here would answer `UNDETERMINED` — which refuses — for every
product on the platform. PI-6.7's enforcement gate would swallow that today,
which is exactly why it must not be relied on: the day somebody moves a pack to
`PRODUCTION_ENABLED`, every procedure in the clinic would stop. The call site is
marked in `consumption.service.ts`'s header for the phase that writes an
administration rule type.

**3. A correction after the close is a second record; an amendment before it is
not.** Both write DELTA ledger legs, because `stock_ledger` has no update path
and never will. What an amendment buys is that the RECORD reads as one event
rather than three — which is what a clinician correcting a typo thirty seconds
later actually means. It is refused once the consultation is signed OR once
anything on it has reached an invoice, whichever comes first.

**4. Four permission codes, not the two the plan named.** `consumption.record`
and `.override` are the two CLINICAL_CONSUMPTION.md asks for. Reading needed its
own code because a doctor holds no `inventory.stock.read` and would otherwise be
unable to see the panel on their own consultation; writing templates needed one
because deciding what a procedure is EXPECTED to use sets the baseline every
variance is measured against, which is a configuration act beside
`inventory.reason_code.manage`. ⚠️ None is a `clinical.*` code and none is
excluded from ORG_OWNER / ORG_ADMIN — an administrator reconciling a treatment
room's trolley is not authoring a chart, and `route-gates.test.ts` now asserts
the router carries no `clinical.*` code at all.

### What it inherited from the PI-8.11 review, and did not repeat

- **The declaration is derived, never trusted.** There is no `isOverride` on the
  request contract at all: whether a line departs from its template is arithmetic
  the server does over two numbers it already holds. The contract suite asserts
  the field is DROPPED rather than honoured if a client sends one, which is the
  case that fails the day somebody adds it back.
- **The template pairing is re-checked.** A line may not cite the glove's
  template line while consuming an implant — the PI-9 analogue of the dispensing
  CRITICAL, where every control hung off a client-set field and the stored row
  then asserted something nobody had written.
- **Every read-then-write over a running total takes the row lock.**
  `amendConsumption` and `correctConsumption` both `SELECT … FOR UPDATE` the
  record first. The reversal ceiling — what came off minus what has gone back —
  is PI-8.11's `alreadyCreditedByItem` finding in this domain.
- **`assertNoOverlap` is a read-then-write that is deliberately NOT locked, and
  the reasoning is written down rather than assumed.** The loser of that race
  writes an overlapping window, not a corrupt one, and
  `resolveTemplateInForceWithin` resolves an overlap deterministically — so the
  failure mode is "the wrong one of two templates pre-fills a panel a human is
  looking at", not a movement of stock.

### What is open, and honestly so

- **Nothing has been clicked in a browser.** The same item every phase has left,
  now across three more screens and one panel.
- **The plan is anchored to the consultation, not to a procedure, on the one
  screen that renders it.** `/v1/consumption/plan` takes an
  `encounterProcedureId` and the service uses it; the consultation page reaches a
  record by encounter id and has no procedure selected, so it plans against the
  visit. A procedure-anchored panel belongs inside the consultation engine, which
  PI-9 deliberately did not reshape.
- **`/code-review` and `security-reviewer` have NOT been run.** This diff touches
  the schema, tenancy, permissions, patient data, billing and raw SQL, so
  CLAUDE.md makes the security review mandatory before merge. Point a reviewer at
  these first, because they are where the phase took its risks: `restateLine`'s
  delta arithmetic and its charge-request delete-and-re-raise, `recordReversal`'s
  ceiling under the lock, `assertMayOverride` being enforced in the service rather
  than at the route, and the five new `*_visible` policies.
- **`@rcln/billing`'s package test suite fails to load**, and it did so before
  this phase — verified by stashing the whole diff. A module-resolution problem in
  the generated Prisma client, unrelated to PI-9 and not fixed here.

### The decisions this phase was required to make, as they were anticipated

**Kept for the reasoning, not the status — every one of the four was taken, and
"The four decisions PI-9 was required to make" above records what was actually
decided.**

1. **What the anchor set is.** CLINICAL_CONSUMPTION.md says only the ANCHOR
   differs across specialties — procedure, encounter, lab order, imaging study —
   and calls it "one nullable-per-kind reference set, not a second subsystem".
   Only `encounters` and `encounter_procedures` EXIST today, so the honest move is
   to build those two and leave the others as enum members with no column, the way
   PI-8 handled `CONTRACT_DEFINED`. ⚠️ A polymorphic `(subject_type, subject_id)`
   pair would be the ADR-0006 mistake wearing different clothes — it cannot carry
   a composite FK, so it cannot be tenant-checked by the database.
2. **Whether a template line may name a platform product.** It may, which means
   `consumption_template_lines.product_id` is a plain FK into a
   platform-extensible table and needs a RESTRICTIVE `product_visible` policy.
   This exact class has produced a CRITICAL in three phases and was still open on
   `dispense_lines.substituted_for_product_id` until PI-8.
3. **Consumption is NOT a charge (PI-ADR-005).** The service emits a
   `charge_request` per consumed line and knows nothing about billability. The
   policy decides. `NEVER_BILL` gloves and a `SEPARATELY_BILLABLE` implant go
   through identical code.
4. **An override is audited and never obstructed.** A dentist who used three pairs
   of gloves used three pairs. Large variances are PI-22's report, not this
   phase's refusal.

### PI-9.9, and the two defects the picker uncovered

The panel now offers the lots — and, for a serialised product, the individual
numbered devices — with FEFO's proposal pre-filled. Building it turned up two
bugs, both of which were ALSO live in PI-7's dispensing path, because that path
had the identical code and no test that exercised either.

**1. ⚠️ THE CANDIDATE CHECK WAS NARROWED TO WHAT FEFO WOULD TAKE, SO EVERY
OVERRIDE WAS REFUSED.** `planAllocation` walks the buckets in order and STOPS
once the requested quantity is covered. Both services planned for the LINE's
quantity and then validated the caller's chosen lots against that plan — so any
lot FEFO had not picked came back "that lot cannot be supplied", which is exactly
the act the override exists to permit. Reaching past the oldest lot for a damaged
strip, or naming the second of two implants, was impossible through the API.
Fixed in both: the candidate list is planned for the whole shelf, and what FEFO
would have taken for the line is computed separately, because the two are
different questions and one plan cannot answer both.

**2. ⚠️ ASSIGNING A SERIAL TO A PATIENT RAISED A 23514 AND REACHED THE CALLER AS
A 500.** `serials_assignment_dated` is
`(assigned_patient_id IS NULL) = (assigned_at IS NULL)`, and both services set
the patient without the date. Every supply of a serialised product TO A PATIENT
failed — which is the whole point of tracking a serial. Nothing in the pharmacy
suite had ever dispensed one, so it shipped.

Both fixes carry a regression test in `pharmacy.test.ts`, and **both tests were
verified to FAIL against the reverted code**: a regression test that passes
either way is worth nothing, and these two guard the exact class of defect that
survives because the happy path is unaffected.

### What it inherits from the PI-8.11 review, and must not repeat

- **Derive the declaration, never trust the client's flag.** The PI-9 analogue of
  the dispensing CRITICAL is a consumption line whose product disagrees with the
  template's while claiming to be the template's — check it server-side.
- **Every read-then-write over a running total needs the row lock**, not just a
  CHECK constraint. Three phases have now paid for this.
- **A comment that describes intent must describe the code beneath it.** Two
  separate CRITICAL/MEDIUM findings have now been comments documenting controls
  nobody had written.

---

# PI-10 — Recall & Traceability · COMPLETE (2026-08-18)

**Dependencies:** PI-2 (batches, serials, the ledger) + PI-4 (goods receipts) +
PI-7 (`dispense_allocations`) + PI-9 (`consumption_allocations`), **all
satisfied**. **Design:** [TRACEABILITY.md](TRACEABILITY.md) — the nine questions
and the two directions; it is the whole specification.

**Migrations:** `20260909090000_recall_traceability` (2 tables, 4 enums, 6
CHECKs, 3 policies) · `..090500_recall_enum_members` (`StockMovementType.RECALL_RELEASE`,
`NumberSequenceType.RECALL`, `DataAccessResource.RECALL_TRACE`) ·
`..091000_recall_release_movement_direction` (the `stock_ledger_direction` CHECK,
restated for the third time).

| Task    | Description                                                             | Status                                                                                        |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| PI-10.1 | `recalls` + `recall_batches` — the notice and the lots it names         | COMPLETE — two tenancy classes, org-only and org+branch                                       |
| PI-10.2 | RLS on both, the isolation cases, and the `*_visible` sweep             | COMPLETE — 1 plain FK, 1 `product_visible`, 14 cases                                          |
| PI-10.3 | `recall.notice.read` / `.create` / `.execute` / `recall.trace.patients` | COMPLETE — four codes; see the note on the fourth                                             |
| PI-10.4 | Contracts in `@rcln/contracts`                                          | COMPLETE — `packages/contracts/src/recall.ts`                                                 |
| PI-10.5 | The workflow — draft, scope, execute, resolve per lot, close, cancel    | COMPLETE — one transaction per execution, no draft movement                                   |
| PI-10.6 | Forward and backward traceability queries                               | COMPLETE — counts under the read code, names under the PHI one                                |
| PI-10.7 | ⚠️ The PI-2 defect it found: a serialised lot could not be held at all  | COMPLETE — fixed in `setBatchHold` and covered by a test that FAILS against the reverted code |
| PI-10.8 | Screens — notices, one notice, trace a lot                              | COMPLETE — 3 screens under `/product-recalls`                                                 |
| PI-10.9 | Tests — unit, integration, isolation                                    | COMPLETE — 21 unit · 23 integration · 14 isolation · 5 route-gate                             |

### Completion gate

`DB` migration + RLS + isolation ✓ · `BE` every service through `withTenant` ✓ ·
`API` contracts + routes + the standard chain ✓ · `FE` 3 screens ✓ · `VAL` Zod on
every surface ✓ · `AUTHZ` four codes, all new ✓ · `AUDIT` `recordAudit` on every
write, `recordDataAccess` on the one read that discloses ✓ · `REG` n/a —
deliberately: no rule type in PI-5 addresses WITHDRAWING a product, the call site
is marked, and a rule engine that could REFUSE a recall would be a defect wearing
a control's clothes · `TEST` ✓ · `DOC` this directory ✓ · `REGRESS` lint (0
errors, 3 pre-existing warnings), typecheck, `db:rls:check` at **128** tables,
**276 unit · 443 isolation · 1 090 integration** all green ✓.

### The five decisions PI-10 was required to make

**1. A recall is a DOCUMENT, not two columns on a batch.** PI-2 gave `batches`
`recalled_at` and `recall_reference` and said the workflow was PI-10. Those two
answer "is this lot recalled"; they cannot answer "what is the manufacturer's
notice, which of the eleven lots have we found, which branch still has some, and
how much did we actually pull". Both are now written in ONE transaction, with the
movement that makes them true.

**2. ⚠️ A BRANCH-SCOPED EXECUTOR PULLS ONLY THEIR OWN LOTS, AND THAT IS THE
CORRECT ANSWER RATHER THAN A LEAK IN THE FEATURE.** `recall_batches` is in the
branch RLS loop, so the rest are invisible to the statement that reads them —
which mirrors the fact that they cannot reach another site's shelf physically
either. The consequences are written down: execution is idempotent over PENDING
rows so the other site executes the same notice, `EXECUTED` means "somebody
executed it" rather than "everything is held", and `closeRecall` refuses while
anything is still PENDING.

**3. ⚠️ THE COUNTS AND THE NAMES ARE TWO ROUTES, TWO PERMISSIONS AND TWO AUDIT
STORIES.** TRACEABILITY.md says the patient link ALWAYS exists in the data and
that who may SEE it is an access-control question. So `/v1/traceability/forward`
answers "37 supplies, 4 procedures, 29 people" under `recall.notice.read` and
names nobody; `/v1/traceability/affected` answers with names and phone numbers
under `recall.trace.patients` ON TOP OF it, and files one `RECALL_TRACE`
disclosure row carrying the count. `route-gates.test.ts` asserts both halves.

**4. `RECALL_RELEASE` is its own movement type.** `QUARANTINE_RELEASE` with a
different `status_from` would have been correct in the statuses and wrong in the
WORD: every report grouping by `movement_type` would file "the manufacturer
withdrew the notice and we put the lot back on sale" alongside "the fridge came
back up to temperature". The `PURCHASE_RETURN`-over-`TRANSFER_OUT` argument,
applied again.

**5. The screen is "Product recalls", not "Recalls".** ⚠️ `/recall` ALREADY
EXISTS — it is the front desk's list of patients who were told to come back and
have not (CE-5). Two tabs called Recall would send the person chasing a
contaminated implant to a list of missed follow-ups. The API keeps the shorter
word because `recall.notice.*` has no such neighbour.

### ⚠️ The PI-2 defect this phase found

**A SERIALISED LOT COULD NOT BE HELD AT ALL, ON EITHER PATH.**
`recordMovementIn` refuses a movement of a `SERIAL` / `LOT_AND_SERIAL` product
that names no serial — and `setBatchHold` selected the lot's balance rows without
`serial_id` and passed none. So `POST /batches/:id/hold`, which has existed since
PI-2, raised "this product is serial-tracked, so every movement of it must name a
serial number" for every implant in the clinic, and pulled nothing. Nothing in
the inventory suite had ever held a serialised lot, so it shipped.

Fixed in both paths, and the serials now follow the lot: without that, a recalled
implant reads `IN_STOCK` on the serial screen while its quantity sits in the
RECALLED bucket — two answers to "may this be fitted", and the screen a theatre
nurse looks at is the one that says yes. `ISSUED` serials are untouched, because
that device is already in a patient and is the trace's business.

**The regression test was verified to FAIL against the reverted code.**

### What is open, and honestly so

- **Nothing has been clicked in a browser.** The same item every phase has left,
  now across three more screens.
- **`/code-review` and `security-reviewer` have NOT been run.** This diff touches
  the schema, tenancy, permissions, patient data and raw SQL, so CLAUDE.md makes
  the security review mandatory before merge. Point a reviewer at `executeRecall`
  (the row lock and the per-lot loop), `resolveRecallBatch` (the "no OTHER live
  recall" check that decides whether a lot goes back on sale), and
  `listAffectedParties` (the one PHI read, and its empty-scope guard).
- **The affected-party list is unioned and paginated IN MEMORY.** Two tables with
  different shapes; a database-side union needs raw SQL over both. Bounded by
  what one lot can reach, and written down in the service rather than discovered.
- **The head count on the notice screen sums per-lot traces**, so a person who
  received two recalled lots is counted twice. It is an upper bound, the screen
  says "received one of these lots", and the exact figure is the affected list's
  own total — available only to somebody who may see it.
- **A recall blocks TODAY's stock, not tomorrow's delivery.** A lot of the same
  number received after the notice is a new `batches` row and is not
  automatically held. PI-23's identifier resolution is where a lot-number rule
  would live.

---

# PI-11 — Veterinary Enablement · COMPLETE (2026-08-19)

**Dependencies:** PI-1, PI-5. **Branch:** `feat/pi-11-veterinary-enablement`.

**⚠️ THIS PHASE ADDED NO TABLE, AND THAT IS THE HEADLINE.** CD-4 landed
`patients.subject_type` and `animal_profiles` back in CE-1 and deliberately built
nothing on them — §42.7 forbade veterinary functionality at the time. The table
had therefore existed **empty and unreachable ever since**: no contract field, no
service, no route, no screen, and no tenant-isolation case despite being named in
that suite's header. PI-11 is the enablement layer.

| Task                                                               | Status                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| PI-11.1 `subject_type` and the animal profile end to end           | COMPLETE — contract, service, routes, chart, search          |
| PI-11.2 The owner as a `patient_contacts` row (ADR-0017)           | COMPLETE — composite FK + the check the FK cannot do         |
| PI-11.3 `SPECIES_RESTRICTION` rule type in `@rcln/regulatory`      | COMPLETE — engine, parser, 10 unit cases; **no India rule**  |
| PI-11.4 Species into every regulatory call site that has a patient | COMPLETE — dispense reads it off the profile, never a client |
| PI-11.5 Weight-based dosing in `@rcln/clinical`                    | COMPLETE — exact rationals, rounds DOWN                      |
| PI-11.6 Tests: isolation, CHECKs, the PHI grep, the arithmetic     | COMPLETE                                                     |

### What landed

| Area        | What                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | 3 columns on `animal_profiles`; `patient_contacts` gains its composite-FK target; `SPECIES_RESTRICTION` on `RegulatoryRuleType`  |
| Migrations  | `..090000_species_restriction_rule_type` · `..090500_pi_11_veterinary_enablement` · `..091000_animal_weight_needs_its_date`      |
| RLS         | `db:rls:check` green at **128** — no new table, and the one new FK is composite so it needs no `*_visible` (same call as PI-10)  |
| Permissions | **None added.** The profile is `patient.read`/`.update`; the dose calculator is `patient.medical_history.read`                   |
| Packages    | `@rcln/clinical/dosing.ts` — `weightBasedDose`, exact `bigint` rationals                                                         |
| Routes      | `PUT /v1/patients/{id}/animal-profile` · `POST /v1/patients/{id}/dose-calculations` — 427 endpoints, 427 documented              |
| Screens     | Animal panel + dose calculator on the chart; subject-type toggle on registration; `Animal` marker in search; species in pharmacy |
| Setting     | `patient.animal_weight_stale_days`, default 90 (PI-ADR-015 — a threshold is never a constant)                                    |

### Decisions a later phase must not undo

**1. ⚠️ INDIA DELIBERATELY GETS NO SPECIES RULE, AND THE NON-ADDITION IS WRITTEN
DOWN.** Rules 65(20) and 97(3) require a veterinary medicine to be **labelled**
"Not for human use" and stored apart. `IN-LABEL-VETERINARY` carries exactly that
and is a `LABELLING_REQUIREMENT`. Neither rule prohibits the **sale** of one for a
human, and the step from "the box must say so" to "the sale is unlawful" is an
inference, not a published rule — writing it would be inventing law, the same
call PI-6 made about quantity limits and e-pharmacy. The rule type is proved
against TESTLAND in `packages/regulatory/tests/engine.test.ts`, which is where
every rule type in this framework is proved.

**2. ⚠️ NO SUBJECT AT ALL IS `UNDETERMINED`, NOT `PERMITTED`.** A counter sale
names nobody, so a species rule cannot be checked there — and PERMITTED would make
the anonymous path the way around the rule, which is the path somebody buying a
veterinary drug for themselves would take. The cost is visible and is the pack
author's to accept by listing `COUNTER_SALE` in `appliesToTransactions`.

**3. `SPECIES_RESTRICTION` is its own rule type and not a parameter on
`AGE_RESTRICTION`.** That handler stands aside **entirely** for an animal — "a
human age limit is not a statement about a dog" — so a veterinary prohibition
written as an age parameter would sit behind a handler that exempts every animal
from itself, and would be inert in exactly the case it was written for.

**4. The species on a DISPENSE is read off the animal's profile, never sent by a
client.** `POST /v1/regulatory/evaluate` accepts one as a hypothesis, for the
reason it accepts `repeatsAuthorised` as one. A dispense must not, or the person
at the counter picks which species rule applies to them.

**5. `subject_type` is absent from the update contract.** A record does not change
species. It governs which care-context ROOT the consultation engine resolves, so
flipping it would leave a chart written under one taxonomy being read under
another and orphan the profile row. A record registered as the wrong kind is a
merge, not an edit.

**6. The dose calculator holds no formulary and recommends nothing.** Every mg/kg
figure comes from a clinician reading a label. It multiplies, reports which
ceiling bound, and writes no clinical record. A daily ceiling reduces the SINGLE
dose rather than trimming the total, so the two figures always multiply — the
obvious implementation returns "220 mg, three times a day, 500 mg daily", which is
two instructions that contradict each other.

**7. ⚠️ ROUNDING IS DOWNWARD — THE ONLY PLACE IN THE CODEBASE THAT DIFFERS FROM
HALF-UP ON PURPOSE.** `@rcln/inventory` rounds a stock conversion half-up because a
count that is systematically low is its own kind of wrong. Rounding a dose up past
a maximum is an overdose. The errors are not comparable.

**8. `weightKg` on the wire is `"18.4"`, not `"18.400"`.** Every decimal goes
through `decimalToString`, which does not pad to the column's scale. The computed
dose fields DO pad, because they report at a declared precision rather than
echoing a column.

### A defect this phase introduced and found

⚠️ **THE FIRST WEIGHT/DATE CHECK GUARDED THE HARMLESS DIRECTION.**
`..090500` wrote `CHECK (weight_recorded_on IS NULL OR weight_kg IS NOT NULL)` —
refusing a date that says nothing, and **accepting a weight nobody can date**,
which is the exact state the feature exists to prevent. The contract had refused
both directions all along, so the gap was reachable only by a fixture, a backfill
or a second service, which is precisely the set of writers a CHECK exists to
catch. The tenant-isolation case found it. `..091000` replaced it with
`("weight_kg" IS NULL) = ("weight_recorded_on" IS NULL)`.

### A second correction, and a note on how big it was not

`resolveWeightStaleDays` originally hand-rolled `typeof resolved === 'number'`
instead of calling `asPositiveInt`, the shared helper that already existed for
exactly this. Replaced.

⚠️ **THE DUPLICATION WAS REAL; THE SEVERITY FIRST CLAIMED FOR IT WAS NOT.** It was
described in-session as a live "configured, visible and completely inert" setting.
It is not: `fits()` in `organization/setting.service.ts` refuses anything but a
JSON number for an `INT` definition, so a stringified value is unreachable through
the product and the hand-rolled guard would have worked. The state is reachable
only by editing `setting_values` directly. The fix stands on the duplication rule
alone — `pnpm kb:find` exists so nobody re-derives a coercion — and the test says
so rather than implying a clinic could trip it.

The same sweep cleared the other five `resolveSettings` call sites: all pass an
explicit `(scopeType, scopeId)` pair, and the two that hand-roll coercion
(`procurement/shared.ts`, `invoicing/pricing.service.ts`) fall back in the STRICT
direction and document why. Left alone deliberately.

---

# PI-11.7 — The review gate over PI-9 + PI-10 + PI-11 · COMPLETE (2026-08-19)

`code-reviewer` and `security-reviewer` run over the combined diff — 147 files,
`git diff 1f8375f~1 HEAD` plus the PI-11 working tree. None of the three phases
had ever been reviewed. **1 CRITICAL, 1 HIGH, 1 MEDIUM, 6 WARNING, 5 INFO. All
fixed.** Every finding was re-verified against the source before being acted on,
and each of the three top findings has a regression test **verified to fail
against the reverted code**.

### ⚠️ CRITICAL — a recall pulled only `AVAILABLE`, so it under-reported and left stock dispensable

`holdBatchWithin` filtered `b.status === 'AVAILABLE'` while the serial sweep
beside it flipped `IN_STOCK` **and** `QUARANTINED` devices. Two consequences:

1. **A false answer to the one question a recall exists to ask.** The
   responsible storekeeper — the one who quarantines the lot on hearing the
   notice — got a recall that moved nothing, recorded `NO_STOCK` and
   `quantity_held_base: 0` for a lot on the shelf, and wrote no ledger leg.
2. ⚠️ **`RESERVED` stock became dispensable again.** The un-dispensable
   guarantee is the BALANCE, not the flag. Quantity left in `RESERVED` is handed
   back to `AVAILABLE` by `releaseReservation` or the expiry sweep, neither of
   which consults the recall, and the allocator then dispenses it — while
   `batches.status` says RECALLED and nothing reads it.

Fixed in both the recall service and `setBatchHold`'s manual `RECALL` path: pull
`AVAILABLE`, `RESERVED`, `QUARANTINED`, `BLOCKED`, `DAMAGED`, `EXPIRED`, pass
`statusFrom` per balance, take the quarantined devices too, and close any ACTIVE
reservation on the lot (`RELEASED`, `released_by_id` NULL — "taken back", not
"given back") so nothing is orphaned.

### ⚠️ HIGH — a recalled lot could be released through the quarantine door

PI-10 added `'RECALLED'` to `QUARANTINE_RELEASE`'s serial source set. The
storekeeper's ordinary "the fridge came back up" button, on a recalled lot,
flipped every serial to `IN_STOCK`, moved no quantity (release reads the
QUARANTINED bucket) so wrote **no ledger leg**, set the batch `ACTIVE` while
leaving `recalled_at` populated, and left `recall_batches.status` on `HELD`. It
sits behind `inventory.batch.manage`, which does **not** imply `recall.execute`.
`resolveRecallBatch` is the only door, and it is the one that checks no OTHER
live notice still names the lot.

### The rest

| Sev     | What                                                                                                                             | Where                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| MEDIUM  | `guardianName`/`guardianPhone` missing from `REDACTED_KEYS` — the allow-list snapshot was right, the backstop was not            | `audit/audit.service.ts`        |
| WARNING | `.trim()` after `.min(1)` accepts whitespace-only and yields `""` — **12 fields**, most predating PI-11                          | `contracts/patients.ts`         |
| WARNING | The chart resolved the stale-weight window org-wide while the calculator resolved it per branch — two answers to one safety flag | `patient.service.ts`            |
| WARNING | The staleness rule existed twice and had already drifted (one copy omitted the null-weight guard)                                | now `weightIsStale()`           |
| WARNING | `dailyDose` was derived from the un-truncated value, so the reported pair did not multiply — `166.666 ×3` beside `500.000`       | `clinical/dosing.ts`            |
| WARNING | `assertBranchInScope`/`resolveBranchId`/`auditMeta`/`q` duplicated across four service directories                               | now `services/shared/branch.ts` |
| INFO    | `MAX_INPUT_SCALE` was 18 (the _precision_ of `Decimal(18,6)`) under a comment claiming it was the scale                          | `clinical/dosing.ts`            |
| INFO    | No `maxSingleDose` input, so `cappedBy: 'SINGLE'` was copy the UI could never produce                                            | `patient-chart.tsx`             |
| INFO    | A future weigh-in date made staleness negative — the flag switched off permanently                                               | `contracts/patients.ts`         |
| INFO    | `prohibitedSubjectTypes` comment promised upper-casing nothing did                                                               | `regulatory/parameters.ts`      |

⚠️ **The dose pair now multiplies, and the daily total under a cap reads
`499.998` rather than `500.000`.** That is deliberate: the printed single dose is
what will actually be given, three times. Reporting the ceiling itself would put
two disagreeing figures on one screen and overstate what the animal receives.

### The two follow-ups, both since done

**1. The renderer is out of the production image.** `@scalar/*` was ~116 MB of
browser bundle in runtime `dependencies` for a page that is off by default in
production, and it is the reason `/docs` has to relax the CSP with `unsafe-eval`.

⚠️ **MOVING IT TO `devDependencies` ALONE WOULD HAVE CRASHED PRODUCTION AT BOOT.**
`app.ts` statically imported the docs router, which statically imported the
package — and `scalarAssetsDir()` was called at module load, resolving the other
package off disk. Both had to become lazy first. So: the import is dynamic, the
asset path resolves inside it, the result is memoized including the failure, and
`/docs` answers **503 with a sentence** rather than 404 — the operator DID turn
the flag on and silence would read as "the flag is broken".

⚠️ **NOTHING AN INTEGRATOR NEEDS WAS LOST.** `/docs/openapi.json` is built
entirely by our own code, needs no Scalar, and still answers in production; any
viewer renders it. Only the pretty page went. `config.docsEnabled`'s comment was
rewritten, because it promised a production capability that no longer exists.

Verified by hiding both packages from `node_modules` and restarting: the API
booted, `/api/v1/health` and `/docs/openapi.json` answered 200, `/docs` answered
503 with the message, and six requests produced exactly one log line.

**2. `assertBranchInScope` went from sixteen copies to three.** Ten byte-identical
ones now import `services/shared/branch.ts`.

⚠️ **TWO HAD ALREADY DRIFTED, WHICH IS THE ARGUMENT FOR THE WHOLE EXERCISE, AND
BOTH WERE LEFT ALONE ON PURPOSE.** `clinical/encounter.service.ts` answers
`NotFoundError('Encounter')` — the caller asked for an encounter and never
mentioned a branch, so naming one would disclose what the check was about.
`patient/patient.service.ts` answers **403**, not 404, because a receptionist
picking a clinic from a list on their own screen needs an actionable message, and
it discloses nothing: the response is identical for another org's branch, an
unscoped branch of this org, and an id that never existed. Both now carry a
comment saying so, so the next sweep does not "fix" them.

### Deliberately not changed

- **`procurement/shared.ts` and `invoicing/pricing.service.ts` hand-rolled
  setting coercion.** Both fall back in the STRICT direction and say why.

### Open

- **No `GET` for the animal profile.** It comes back on the patient record, so a
  second endpoint would be a second disclosure to log and a second shape to keep
  in step. Revisit only if a caller genuinely needs it alone.
- **Consumption still does not consult the law**, and PI-11 did not change that.
  PI-9's reasoning stands: no rule type addresses administering rather than
  supplying, so `evaluateWithin` would answer `UNDETERMINED` for every product.
  A species rule for `CONSUME` needs that decision reversed first.
- **PI-11 has not been through `/code-review` or `security-reviewer`.** Neither
  have PI-9 and PI-10. The diff touches the schema, tenancy and patient data.

---

# PI-12 — Online Pharmacy · COMPLETE (2026-08-19)

Branch `feat/pi-12-online-pharmacy`. **NOT REVIEWED.**

Three tables, ten endpoints, three screens — and the phase's whole argument is
about the two things it deliberately did NOT build a second copy of.

| Area        | What landed                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine      | `onlineSaleGap` in `@rcln/regulatory` — `online_sale_position` becomes decisive for `ONLINE_DISPENSE`, and only for it                                         |
| Schema      | `online_orders` · `online_order_lines` · `online_order_shipments`; `DispenseKind.ONLINE`, `NumberSequenceType.ONLINE_ORDER`, `DataAccessResource.ONLINE_ORDER` |
| Migrations  | `..090000_online_pharmacy_enum_members` · `..090500_pi_12_online_pharmacy`                                                                                     |
| RLS         | `db:rls:check` green at **131**. Three tables, ONE tenancy class — all branch-scoped                                                                           |
| Permissions | `pharmacy.online_order.read` / `.manage` / `.dispatch`. ⚠️ Packing is gated on `pharmacy.dispense.create`                                                      |
| Services    | `pharmacy/online-order.service.ts` (order) · `pharmacy/fulfilment.service.ts` (parcel); `createDispenseWithin` extracted; `reserveStockIn` extracted           |
| Routes      | `/v1/online-orders` — 10 endpoints. **437 endpoints, 437 documented**                                                                                          |
| Screens     | Deliveries list, Take an order, the order page with a stage rail and one action at a time                                                                      |
| Tests       | +22 integration, +18 isolation, +9 regulatory unit, +7 route-gate cases                                                                                        |

## PI-12.1 — The gate that makes "no product is onlineable by default" true

⚠️ **THE FAIL-OPEN WAS REAL AND SURVIVED SEVEN PHASES.** A real pack lists
`ONLINE_DISPENSE` alongside `DISPENSE` on its prescription rules — it has to, or
the prescription requirement stops applying the moment a medicine goes in a
parcel — and the consequence is that a pack which says NOTHING about remote
supply PERMITS it, on the strength of rules written about a counter. India's pack
is exactly that shape (PI-6 recorded the e-pharmacy position as `UNKNOWN` and
wrote no rule). No rule refused; no rule was asked.

`product_regulatory_profiles.online_sale_position` has existed since PI-5, been
written by the profile screen since PI-5, and been read by nothing. It is now
decisive for exactly one transaction: `PROHIBITED` → `REFUSED`, anything else
that is not `PERMITTED`/`RESTRICTED` → `UNDETERMINED`, which refuses. An
unrecognised string fails CLOSED, which is why the field stays a `string` in the
package.

⚠️ **AND IT IS CHECKED IN THE SERVICE AS WELL, WHICH IS NOT BELT-AND-BRACES BUT
LOAD-BEARING.** A `REFUSED` decision enforces nothing until a named human signs
the jurisdiction's pack off, and no pack is `PRODUCTION_ENABLED`. If the engine
were the only gate, every product in every configured country would have been
sendable by post the day this shipped. `confirmOnlineOrder` therefore refuses
directly, on the CLINIC's own configuration — the same class of check as
`is_dispensing_point` and `products.status` — and `onlineSaleGapMessage` is shared
so the two never word it differently.

## PI-12.2 — One supply path, and one hold

**`createDispense` was split into `createDispenseWithin`.** Packing a parcel has
to write the dispense, consume the holds and move the order's status in ONE
transaction, so it could not call a function that opens its own. The alternative
was a parallel posting function, and PI-11's review already wrote down what that
costs: _a second door into a status change is a second door into the hazard_. The
seam is `RemoteSupply` — three fields a client must never be able to state.

**Accepting an order HOLDS; packing SUPPLIES.** Confirm plans FEFO and writes one
`RESERVATION` leg per lot (AVAILABLE → RESERVED). Pack claims the reservations
CONSUMED **before** any ledger leg — the claim-before-you-move discipline
`releaseReservationIn` documents — and then dispenses with `statusFrom: RESERVED`.
Taking from AVAILABLE at pack time would remove the quantity twice.

⚠️ **A HOLD CITES THE ORDER _LINE_, NOT THE ORDER.** `stock_reservations` carries
a product and a lot and no line, so an order naming one product twice would leave
packing unable to say which line each lot belonged to. `online_order_lines` is
therefore UNIQUE on `(organization_id, online_order_id, product_id)` as well, and
the service refuses a duplicate with a sentence.

`StockReservationStatus.CONSUMED`, `StockReferenceType.ONLINE_ORDER` and
`NumberSequenceType.ONLINE_ORDER` were all added by earlier phases and left
unreached on purpose. This is the phase that reaches them; none needed a
migration for it.

## PI-12.3 — What this phase deliberately did not build

- **No patient-facing surface.** There is no patient portal in this product and
  PI-12 does not invent one. An order ARRIVES and staff record it, which is what
  `channel` says — so the RLS and permission story is the ordinary one rather
  than a new anonymous boundary.
- **No click-and-collect.** Folding it in makes both the destination and the
  shipment nullable, which is two silent paths through the highest-risk write in
  the phase.
- **No partial shipment.** One consignment per order, by unique index. Splitting
  one means splitting the dispense, the charge requests and the reservations
  three ways.
- **No substitution on an order.** The conversation happens before the
  confirmation, so the remedy is to cancel and re-place.
- **A failed delivery moves no stock.** The parcel is somewhere and the clinic
  does not have it back; putting the quantity on the shelf on a courier's status
  update would make the balance say the clinic holds medicine it cannot find.
  What comes back comes back as a `dispense_returns` row.

## PI-12.4 — Two defects found in code this phase did not write

**1. ⚠️ `dispenses_prescription_has_patient` WOULD HAVE REFUSED EVERY PARCEL.**
PI-7 wrote it as a two-way choice between the counter's two kinds; an `ONLINE`
dispense satisfies neither arm. Rewritten with a third arm tying ONLINE to a
PATIENT and deliberately not to an encounter.

**2. ⚠️ A PI-11 TEST ASSERTED THE OPPOSITE OF WHAT ITS OWN REVIEW FIXED.**
`patients.test.ts` expected `dailyDose: '500.000'` under a daily cap, while
`weightBasedDose` had been changed — by PI-11's review, with the number `499.998`
written into the code comment — so the reported pair always MULTIPLIES. The
assertion was stale and the suite has been red since PI-11 landed. Corrected to
`166.666` × 3 = `499.998`, with the reasoning beside it.

## PI-12.5 — The security review, and what it found

`security-reviewer` ran over the whole diff. **2 CRITICAL, 1 HIGH, 3 MEDIUM,
4 LOW — all acted on.** Both CRITICALs had a regression test written and verified
to FAIL against the reverted code.

⚠️ **`/code-review` DID NOT COMPLETE** — the agent died on a session limit part
way through. The invariant/quality pass was done by hand instead and is the
weaker of the two; it should be re-run.

**⚠️ CRITICAL 1 — `online_order_lines` shipped without its `*_visible` policies,
and the comment saying it did not need them was false on both counts.** It cited
`dispense_lines` as having "the identical absence" (it has all three, added in
PI-8 as a CRITICAL fix whose own note calls the earlier gap "a hole rather than a
choice") and `recall_batches.batch_id` as precedent (`batches` is ORG-SCOPED and
can never hold a platform row — that difference IS KI-3). `tenant_isolation`
constrains the LINE's `organization_id` and says nothing about which `products`
row it cites, so a clinic could attach another clinic's private product to its
own order and read the name back through the join. Fixed with both policies in
`enable-rls.sql` and the migration, plus three isolation cases — two of which
fail with the policies dropped, verified.

**⚠️ CRITICAL 2 — the remote-supply gate was bypassable through the counter
endpoint.** `DispenseKind` had to gain `ONLINE` for the column's sake, and
widening the shared enum silently widened `createDispenseRequest` with it. A
caller holding `pharmacy.dispense.create` could post `kind: 'ONLINE'` to
`POST /v1/pharmacy/dispenses`; `createDispenseWithin` evaluated it under
`ONLINE_DISPENSE` with no `RemoteSupply`, so `assertRemoteSupplyIsOpen` never
ran, no destination was supplied, and the supply left no `online_orders` row
recording where the parcel went. The engine's own gate refused and refusing
changed nothing — no pack is `PRODUCTION_ENABLED`, which is the entire reason the
service gate exists. **The phase opened its own second door by widening an enum.**
Refused now at the contract AND in `createDispense`; the regression test creates
a dispense when either is reverted.

**HIGH — the destination jurisdiction is DECLARED, not derived**, and the
contract header claimed otherwise. The claim was wrong; the code was always
going to be. Corrected to say so plainly.

⚠️ **A VALIDATION WAS WRITTEN FOR IT AND THEN REMOVED, WHICH IS WORTH RECORDING.**
`assertDestinationIsAPlace` refused a region naming no `jurisdictions` row — and
refused `IN-KA` on its first run. That table lists places rcln has written RULES
for, not places that exist, so it cannot tell Karnataka from a typo. Nor could it
be narrowed to "once we know a country's regions": seeding `IN-KA` says nothing
about Maharashtra. The region is therefore unvalidated, said plainly, and bounded
by evidence instead — the pair is frozen beside the address, cited by the
snapshotted decision, and on the audit row (which now carries the region as well
as the country).

Also fixed: `assertBranchInScope` on the list (house pattern, was missing);
`organizationId` explicit on the reservation claim; the new PHI fields added to
the logger's redact paths; `patientAddressId` now checked to belong to the
order's patient; and the branch-vs-destination profile lookup documented as the
deliberate call it is rather than left to be rediscovered.

One finding of my own, outside both agents: `online-order-detail.tsx` imported a
string map from `online-order-list.tsx`, dragging the whole list client component
into the detail bundle. Split into `online-order-status.tsx`.

## PI-12.6 — The code review, on the second attempt

`/code-review`'s invariant agent died on a session limit the first time and was
re-run. **No CRITICAL, no HIGH. 8 WARNING, 7 INFO — all acted on.**

⚠️ **IT CONFIRMED THE FIVE THINGS THE PHASE WAS MOST EXPOSED ON**, which is worth
recording because three of them were argued from comments that were wrong:

- **`RemoteSupply.held` keyed by the request-line OBJECT is correct on every
  path** — `[...body.lines].sort()` copies the array, not the elements. ⚠️ AND IT
  DOES NOT DEPEND ON THE ONE-LINE-PER-PRODUCT INDEX, which two comments implied
  it did. Both corrected: the index exists so RESERVATIONS can be attributed to
  a line, a different problem one layer down.
- **The encounter-load condition change is behaviour-preserving.** The contract
  already refuses `encounterId` on a counter sale, so widening it added exactly
  one case — `ONLINE`.
- **`confirmOnlineOrder`'s ordering is right, for a reason the comment got
  wrong.** It credited the canonical sort with preventing oversell; the sort
  prevents DEADLOCK, and what makes acting on a stale plan safe is that
  `reserveStockIn` writes the movement first and the movement takes the bucket
  lock. Comment corrected.
- **`packOnlineOrder`'s claim-then-move is a proper compare-and-swap** and cannot
  leave the order and the buckets disagreeing.
- **The web layer honours the Next 16, colour-token, date and link conventions.**

Fixed: the whole 460-line order screen was `'use client'` to run four forms —
`OnlineOrderActionCard` is now the only client component and the actions reach it
already bound; `fieldErrors` were computed and discarded on both new forms, so an
error was on screen and unlinked (AGENTS.md: it "does not exist to a screen
reader"); neither form used `useOutcomeFocus`; a 12px stage label carried
`opacity-70`, the exact contrast bug AGENTS.md names; `STATUSES` retyped all seven
labels nine lines below importing the module created to hold them;
`branchJurisdictionWithin` read a branch without `organizationId` (ADR-0005);
`req.body.notes` and the town/state were missing from the redact paths; and the
`IDLE_FORM` re-export from a `'use server'` module — the one shape the file's own
comment forbids two lines above it — is gone.

Also: a self-enforcing assert on the `RemoteSupply` seam (ONLINE and `remote`
travel together or not at all), the condition-list key collision, a decimal
string no longer parsed through a float for a display decision, `timeFormatOf`
lifted out of the order's dependency chain, and the pagination controls sized
past 24×24 (WCAG 2.5.8).

## Open

- **Nothing from either review is outstanding.** Both agents have run over the
  whole diff and every finding is fixed or recorded in KNOWN_ISSUES.
- The identifier-resolution debt (#25, #25b) is what a reviewer would notice
  first about the order screen, and it is PI-23's.
- **No worker sweep releases a hold when an order is abandoned.** The existing
  reservation sweep does it by `expires_at`, which is why `holdForDays` is
  capped — but the ORDER is then left CONFIRMED with nothing held, and only
  `heldQuantityBase: 0` on the screen says so. A status of its own would be
  honest; it needs a decision about who moves it.
- **Recall does not walk online orders.** It walks `dispense_allocations`, which
  a packed order writes — so a PACKED parcel IS traced. An order that is merely
  CONFIRMED holds recalled stock in the `RESERVED` bucket and PI-10's execution
  cannot reach it. PI-22/PI-23 territory.
- **The product picker is still capped at 100** on the order form, like every
  other picker in this programme. PI-23.

---

# PI-13a — Rule-pack framework extensions · IN_PROGRESS

**Dependencies:** PI-5, PI-6. **Priority:** P0 — every remaining country pack
waits on it. **Size:** S.

Scoped from [COUNTRY_RULE_PACK_SURVEY.md](COUNTRY_RULE_PACK_SURVEY.md), which
surveyed all nine remaining jurisdictions for rule shapes the engine cannot
express. It exists so that `engine.ts` — the file every jurisdiction depends on
— is extended **once** rather than nine times.

⚠️ **NOT ONE COUNTRY'S RULES LAND IN THIS PHASE.** It is framework only, tested
against the synthetic `ZQ` packs in `packages/regulatory/tests/engine.test.ts`,
which is where every rule type in this programme is tested. A pack that needs
one of these keys gets it in its own phase.

⚠️ **NO MIGRATION.** Five gaps, none of them in the database. `jurisdictions.region_code`,
the `NULLS NOT DISTINCT` index and per-rule-type supersession were all built in
PI-5 and have never been exercised.

**Completion date:** 2026-08-19 · **Validation:** ran once at the end —
`pnpm lint`, `pnpm format`, `turbo typecheck --concurrency=1`, then the tests.
1929 API tests across 93 suites, 120 regulatory, 665 across the other packages;
`db:rls:check` 131 tables; `docs:validate` 437/437. All green.

### PI-13a.1 — Calendar-month validity (survey GAP 1, 4+ of 9 jurisdictions)

`validityDays` is a day count; US, GB, AU and IE all state validity in calendar
months. ⚠️ `180` is an invention that fails in the refusing direction — 1 January
to 1 July is 181 days.

- **BE** `validityMonths` on `PrescriptionRequiredParameters` and
  `RefillRuleParameters`; calendar-month arithmetic in `engine.ts`; both keys may
  be present and the earlier expiry governs
- **TEST** a month-stated rule against the day before, the day of, and the day
  after expiry, across a month-length boundary (28/29/30/31)
- **Status** COMPLETE

### PI-13a.2 — Preconditions established outside the transaction (GAP 2, 3 of 9)

US 829(e)'s in-person evaluation, AU's Schedule 8 permit, AE's narcotic form.
⚠️ Today `permitted: true` returns `PERMITTED` in silence, which inverts 829(e).

- **BE** condition kinds `VERIFY_PRIOR_IN_PERSON_EVALUATION` and
  `VERIFY_PRIOR_AUTHORISATION`; `requiresPriorInPersonEvaluation` on
  `OnlineDispensingParameters`; `priorAuthorisationRequired` /
  `authorisationAuthority` on `ControlledScheduleParameters`
- **API** the kind enum in `packages/contracts/src/regulatory.ts` must match
- **TEST** the condition is raised, and is absent when the rule does not ask
- **Notes** ⚠️ first conditions the dispenser cannot themselves discharge — the
  UI treatment is an open decision, not a detail
- **Status** COMPLETE

### PI-13a.3 — Days'-supply quantity limits (GAP 3, 2 of 9)

- **BE** `maxDaysSupply` on `QuantityLimitParameters`; optional `daysSupply` on
  the request; absent where a rule needs it → `UNDETERMINED`, matching how
  `evaluateOnlineDispensing` treats a missing destination
- **Status** COMPLETE

### PI-13a.4 — Sub-national pack seeding (GAP 5)

- **BE** `regionCode` on `PackSeed` in `seed/regulatory-packs.ts`, which
  hardcodes `null` today. Machinery only — still no `if (country === …)`
- **TEST** a regional pack supersedes the national one **per rule type**, and
  leaves the national rules of every other type standing
- **Status** COMPLETE

**Deliberately NOT in scope:** contained-substance limits (survey GAP 4 — US
pseudoephedrine, 3.6 g of base against a product measured in tablets). Needs
composition arithmetic; a half-modelled version is worse than an honest absence,
which is India's NDPS call made again.

**Next action:** PI-18 (IE). PI-14 (GB) stays blocked until an access route to
legislation.gov.uk exists.

---

# PI-13 — United States rule pack · COMPLETE

**Dependencies:** PI-13a. **Size:** M. **Completion date:** 2026-08-19.

Federal (DEA + FDA) plus a California state pack, so that the sub-national path
is exercised by the phase that introduces it. Primary sources are read and
recorded: eCFR's XML API for 21 CFR 1301/1304/1306/201.105, govinfo for 21 U.S.C.
353/829/830, leginfo.legislature.ca.gov for California B&P 4073/4076/4081.

The supersession demonstration is **record retention**: federal 21 CFR 1304.04(a)
is two years, California B&P § 4081(a) is three, same rule type, state wins.

⚠️ **NO PSEUDOEPHEDRINE RULES** — survey GAP 4. ⚠️ **NO DSCSA TRACEABILITY
RULES**: 21 U.S.C. 360eee-1 could not be retrieved from a primary source, and no
source means no rule. Both cells stay `RESEARCH_REQUIRED`.

Seeded: `US 1.0.0` — 2 authorities, 7 sources, **39 rules** — and `US-CA 1.0.0`
— 1 authority, 3 sources, **3 rules**, the programme's first sub-national pack.
Both at `AUTOMATED_TESTED`, which is earned: the rules exist, the call sites
consult the engine, and 26 behaviour tests ship with them
(`apps/api/tests/integration/us-rule-pack.test.ts`). **Not one rung higher** —
sources are `UNVERIFIED` and no qualified person has read either pack, so
nothing here blocks anything: enforcement is gated on `PRODUCTION_ENABLED`.

- **DB** n/a — no migration. `jurisdictions.region_code`, the `NULLS NOT
DISTINCT` index and per-rule-type supersession were all built in PI-5
- **BE** seed data files + `regionCode` on `PackSeed`
- **TEST** 26 behaviour cases, incl. the four California supersession cases that
  are the first exercise regional packs have ever had
- **DOC** COUNTRY_SUPPORT_MATRIX (US column, 14 dimensions to `SUP`),
  KNOWN_ISSUES (5 entries), COUNTRY_RULE_PACK_SURVEY, CHANGELOG
- **REGRESS** green — see PI-13a above
- **Status** COMPLETE ⚠️ **not reviewed** — neither `/code-review` nor the
  security reviewer has run over this diff

---

# PI-15 — Australia rule pack · COMPLETE

**Dependencies:** PI-13a. **Size:** M. **Completion date:** 2026-08-20.

National (the Poisons Standard) plus **Victoria**, because the survey ruled that
an AU pack without a state pack "must not ship": the Poisons Standard recommends
and has no legal force except through State and Territory legislation, so a
national-only pack would describe an instrument binding nobody. Primary sources
read and recorded: the Federal Register's own text of the Therapeutic Goods
(Poisons Standard—June 2026) Instrument 2026, and the Chief Parliamentary
Counsel's authorised consolidation of the Drugs, Poisons and Controlled
Substances Regulations 2017 (Vic), Version 021.

**Victoria and not New South Wales**, which is larger: legislation.nsw.gov.au
returned `403` on every path — the same wall PI-14 is behind — and NSW's 1966 Act
is mid-replacement by the Medicines, Poisons and Therapeutic Goods Act 2022.

The supersession demonstrations are **prescription validity** (no national
expiry; Victoria reg 50(2) twelve months for S4, reg 51(3) six for S8) and the
**Schedule 8 controls** (the national rule names the schedule and imposes
nothing; Victoria adds the register and the treatment permit). `VIC-PERMIT-S8`
is the first `VERIFY_PRIOR_AUTHORISATION` any real pack has raised — PI-13a built
that condition kind with Australia's S8 permits named in the comment.

⚠️ **A LATENT DEFECT WAS FOUND AND FIXED, AND IT WOULD HAVE MADE THIS PHASE
SHIP DEAD.** `locale.ts` gave Australia `regions: []`, scoped to "does GST
register per state". `isValidRegion` gates `branches.region_code`, which is the
column the regulatory engine reads to pick a pack — so no branch could say it was
in Victoria and `AU-VIC` would have seeded, printed in the console and matched
nothing forever. `AUSTRALIA_REGIONS` now exists and `regions` is documented as
the subdivisions a branch may be IN rather than where tax registers. The United
States has the same hole for its five no-sales-tax states; no pack exists for any
of them, so it is recorded rather than fixed blind.

⚠️ **NO APPENDIX L**, so no national dispensing label: the instrument's HTML
truncates before the appendices. ⚠️ **NO IMPORT RESTRICTION** — the Customs
(Prohibited Imports) Regulations 1956 could not be reached. ⚠️ **NO PBS RULES**,
which apply only to subsidised supply, a fact this platform does not hold.
⚠️ **NO S9, CHART-INSTRUCTION OR EMERGENCY-SUPPLY RULES** in Victoria — the last
makes the pack _stricter_ than the law in those cases, which is recorded rather
than softened.

Seeded: `AU 1.0.0` — 1 authority, 1 source, **4 rules** — and `AU-VIC 1.0.0` —
1 authority, 7 sources, **18 rules**, the programme's second sub-national pack
and its first non-US one. Both at `AUTOMATED_TESTED`, which is earned: the rules
exist, the call sites consult the engine, and 20 behaviour tests ship with them
(`apps/api/tests/integration/au-rule-pack.test.ts`). **Not one rung higher** —
sources are `UNVERIFIED` and no qualified person has read either pack.

- **DB** n/a — no migration, for the third rule-pack phase running
- **BE** `data/regulatory-au.ts`, `data/regulatory-au-vic.ts`, two `PACKS`
  entries; `AUSTRALIA_REGIONS` in `@rcln/contracts`
- **TEST** 20 behaviour cases, incl. the storage asymmetry and the Schedule 3
  case that proves the state pack did not repeal the national one
- **DOC** COUNTRY_SUPPORT_MATRIX (AU column), KNOWN_ISSUES, CHANGELOG
- **Status** COMPLETE ⚠️ **not reviewed**

# PI-16 — Singapore rule pack · COMPLETE

**Dependencies:** PI-13a. **Size:** M. **Completion date:** 2026-08-20.

National only, and that is a fact about the country rather than a shortcut:
Singapore is a city-state, `CountryInfo.regions` for `SG` is `[]` and
`labels.region` is `null`. ⚠️ **THE `regions` LIST WAS CHECKED FIRST**, because
PI-15 shipped a state pack that an empty list would have made inert forever —
here the emptiness is correct, and the check is recorded so nobody repeats it.

Primary sources read and recorded, all from Singapore Statutes Online, the
Attorney-General's Chambers' authorised publication: the Health Products
(Therapeutic Products) Regulations 2016 (S 329/2016), the Health Products
(Licensing of Retail Pharmacies) Regulations 2016 (S 330/2016), and the Misuse of
Drugs Regulations.

⚠️ **THE STRUCTURAL FACT THIS PACK IS SHAPED BY: SINGAPORE REGULATES A MEDICINE
UNDER TWO INSTRUMENTS THAT DO NOT SHARE A VOCABULARY.** HSA classifies a product
as prescription-only, pharmacy-only or general sale list; the Misuse of Drugs
Regulations classify a controlled drug by Schedule. Morphine is both, and
`product_regulatory_profiles.classification` is ONE string — so every
controlled-drug rule is written to stand alone rather than lean on the
therapeutic-products rules for a prescription requirement it would not inherit.
Recorded in KNOWN_ISSUES as the framework limitation it is.

⚠️ **NO PHARMACIST-ONLY RULE FOR A PRESCRIPTION-ONLY OR PHARMACY-ONLY MEDICINE,
AND IT IS THE MOST CONSIDERED OMISSION IN THE PROGRAMME SO FAR.** Every other
pack has one. Regulation 11(c) permits supply by "a person acting in accordance
with the oral or written instructions of a qualified practitioner", and
regulation 3(3) of the Licensing of Retail Pharmacies Regulations disapplies the
in-store-pharmacist gate to exactly the clinic case. The gate turns on what the
PREMISES are licensed as, which rcln does not hold — so a rule would refuse the
ordinary Singapore clinic, a wrong answer in the refusing direction. The
controlled-drug supply rules are unaffected: regs 7(2) and 8(2) name a closed
list with no instructions limb, and `SG-SUPPLY-CD2` is it.

⚠️ **NO PRESCRIPTION EXPIRY FOR A PRESCRIPTION-ONLY MEDICINE** — these
Regulations impose none, and 6 months would have been an invention. Controlled
drugs do have one, 30 days, reg 12(1), and carry it. ⚠️ **NO 355 mg CONTAINED-
CODEINE LIMIT** (survey GAP 4, the US pseudoephedrine call made again); the
240 ml liquid limb of the same regulation IS written. ⚠️ **NO GENERAL SALE LIST,
E-PHARMACY, CONTAINER-MARKING OR ADDICT-NOTIFICATION RULES** — each argued in
the header of `seed/data/regulatory-sg.ts`.

Seeded: `SG 1.0.0` — 2 authorities, 3 sources, **28 rules**, at
`AUTOMATED_TESTED`, which is earned: the rules exist, the call sites consult the
engine, and 23 behaviour tests ship with them
(`apps/api/tests/integration/sg-rule-pack.test.ts`). **Not one rung higher** —
sources are `UNVERIFIED` and no qualified person has read the pack.

- **DB** n/a — no migration, for the fourth rule-pack phase running
- **BE** `data/regulatory-sg.ts`, one `PACKS` entry
- **TEST** 23 behaviour cases, half of them pinning rules that are deliberately
  ABSENT — the missing pharmacist gate, the missing expiry, the Third Schedule's
  missing register and missing witness
- **DOC** COUNTRY_SUPPORT_MATRIX (SG column), KNOWN_ISSUES, CHANGELOG,
  COUNTRY_RULE_PACK_SURVEY, REGULATORY_RULE_PACKS
- **Status** COMPLETE ⚠️ **not reviewed** — neither `/code-review` nor the
  security reviewer has run over this diff

**Validation:** ran once at the end, per CLAUDE.md — `pnpm lint`, `pnpm format`,
`turbo typecheck --concurrency=1`, then the tests. ⚠️ `pnpm test` still OOMs the
api container (KNOWN_ISSUES #2), so the api suite ran in five path slices:
**299 unit + 1,681 integration + 470 tenant-isolation, all green**, plus every
other workspace package through `turbo run test`. `db:rls:check` 131 tables;
`docs:validate` 437/437. No migration, so nothing moved in the schema.

---

# PI-17 — United Arab Emirates rule packs · COMPLETE

**Dependencies:** PI-13a. **Size:** M. **Completion date:** 2026-08-20.

⚠️ **TWO SUB-NATIONAL PACKS AND NO NATIONAL ONE — THE FIRST TIME THAT SHAPE HAS
APPEARED IN THIS PROGRAMME, AND THE PHASE'S CENTRAL FINDING.** The survey scoped
PI-17 as "federal plus at least one emirate". The federal half is unreachable:
`uaelegislation.gov.ae` returns `403` on every path and `mohap.gov.ae` resets the
connection — the same wall PI-14 (GB) and New South Wales are behind. The federal
Ministerial Decrees both emirates cite (888/2016, 379/2019, 253/2020, 680/2017)
and Federal Laws 8/2019 and 14/1995 were read only AS RESTATED by the emirate
regulators, which is a secondary source, and this programme does not write rules
from one. **No rule in either pack cites a decree.**

⚠️ **THE CONSEQUENCE IS WORSE THAN AUSTRALIA'S AND IS RECORDED RATHER THAN
SOFTENED.** A branch in Sydney with no state pack still gets the Poisons Standard
as a floor; a branch in Sharjah, Ajman, Fujairah, Ras al-Khaimah or Umm al-Quwain
gets nothing, so every evaluation there answers `UNDETERMINED`, which refuses. A
behaviour case pins it.

⚠️ **AND BOTH PACKS WOULD HAVE SHIPPED INERT.** `CountryInfo.regions` for `AE`
was `[]` — correct about VAT, which is federal at one rate — while `labels.region`
already said `'Emirate'`. `isValidRegion` gates `branches.region_code`, so no
branch could have said `AZ` or `DU`. **This is the second country with the defect
in three phases** (Australia was PI-15), which makes it a class rather than an
accident. `UAE_REGIONS` lists all seven emirates, not just the two with a pack,
because omitting a subdivision until it needs one is exactly the shape of the
still-open `US_REGIONS` hole.

Seeded: `AE-AZ 1.0.0` — 1 authority, 1 source, **25 rules**, from the Department
of Health Abu Dhabi's own standard DOH/HLME/DMP/1.0/2021 — and `AE-DU 1.0.0` — 1
authority, 1 source, **26 rules**, from the DHA Pharmacy Guidelines
HRS/HPSD/PG/01/2021. Both at `AUTOMATED_TESTED`; sources `UNVERIFIED`; no
qualified person has read either.

⚠️ **THE DUBAI DOCUMENT MOSTLY RECOMMENDS.** 100 pages of "should", "may" and "it
is recommended", with Guideline Fourteen (narcotics, CDs, SCDs) written in
"shall"/"must"/"is prohibited". The pack is built from the mandatory register
only — which is why Dubai has no dispensing label rule despite the guidelines
carrying an eleven-field label at 13.3.2: a `LABEL_FIELDS` condition is an
obligation, and that clause is advice.

⚠️ **NO DAYS'-SUPPLY LADDER IN EITHER PACK**, and this is the largest omission.
Both regulators set GP 3 days / specialist 15 / consultant 30, conditioned on the
**prescriber's grade** — which is not a property of a rule. Three rules of one
type against one classification tie, `mostSpecific` keeps ties, and a refusal
beats a permission, so the GP limit would govern every consultant's prescription.
Independently, nothing populates `daysSupply`, so any `maxDaysSupply` rule
answers `UNDETERMINED` for every caller and would refuse every controlled supply
in the country. The ladder is in the rule statements instead.

- **DB** n/a — no migration, for the fifth rule-pack phase running
- **BE** `data/regulatory-ae-az.ts`, `data/regulatory-ae-du.ts`, two `PACKS`
  entries; `UAE_REGIONS` in `@rcln/contracts` and the second entry in the
  `CountryInfo.regions` warning
- **TEST** 22 behaviour cases, incl. the branch-to-branch transfer prohibition,
  the emirates disagreeing about the unified platform, and Sharjah
- **DOC** COUNTRY_SUPPORT_MATRIX (AE row + column), KNOWN_ISSUES, CHANGELOG,
  COUNTRY_RULE_PACK_SURVEY, REGULATORY_RULE_PACKS
- **Status** COMPLETE ⚠️ **not reviewed** — neither `/code-review` nor the
  security reviewer has run over this diff

**Validation:** ran once at the end, per CLAUDE.md — `pnpm lint`, `pnpm format`,
`turbo typecheck --concurrency=1`, then the tests. ⚠️ `pnpm test` still OOMs the
api container (KNOWN_ISSUES #2), so the api suite ran in six path slices:
**299 unit + 1,225 integration + 470 tenant-isolation, all green**, plus 25
workspace packages through `turbo run test`. `db:rls:check` 131 tables;
`docs:validate` 437/437. No migration, so nothing moved in the schema.

⚠️ **THE `[e-l]` SLICE WAS KILLED ON ITS FIRST RUN AND RE-RUN TO GREEN.** A
backgrounded slice that is killed prints nothing and looks exactly like one still
running — worth knowing for the next session that runs the suite in pieces.

---

## PI-18 — Ireland Rule Pack

**Branch:** `feat/pi-18-ie-rule-pack` · **Result:** complete, ⚠️ **not reviewed**

`IE 1.0.0` — 50 rules, 7 sources, 3 authorities, no migration. The sixth
rule-pack phase running with no schema change, and the first that needed a
framework key.

### The finding: a jurisdiction that FORBIDS remote supply

Every pack before this one either said nothing about remote supply — which
PERMITS it, on the strength of rules about a counter, as
`packages/regulatory/tests/online-sale-gap.test.ts` shows — or conditioned it
(21 U.S.C. 829(e)). Ireland prohibits it, in three provisions that leave no room:
regulation 19(1) of S.I. No. 540 of 2003, regulation 19(5) as inserted by S.I.
No. 87 of 2015, and regulation 19A(8)(b). Every prescription-controlled
classification carries `ONLINE_DISPENSING` with `permitted: false`, which
REFUSES — the first in the programme.

⚠️ **THIS IS WHERE PI-12'S SECOND GATE STOPS LOOKING REDUNDANT.** A `REFUSED`
decision enforces nothing until a named human sets a pack to
`PRODUCTION_ENABLED`, and nobody has. `confirmOnlineOrder` refuses independently,
on the clinic's own `online_sale_position`. Ireland is where the two finally
agree about the same product — and only one of them cites the law.

### The one framework change: `requiresDistanceSellingAuthorisation`

Regulation 19A(1) permits distance selling of a NON-prescription medicine only by
a supplier "entered on the ISS supply list" the Pharmaceutical Society of Ireland
keeps. Written with the keys that existed before PI-18, the closest expressible
rule was a bare `permitted: true` — which asserts the opposite of the regulation,
the same inversion `requiresPriorInPersonEvaluation` was added to stop in PI-13a.

Added to `OnlineDispensingParameters`, parsed, and raised as
`VERIFY_PRIOR_AUTHORISATION` — the condition kind that already exists for exactly
this shape. It mirrors `ControlledScheduleParameters.priorAuthorisationRequired`
key for key and is deliberately not a second idea. The alternative was to write
no rule at all, which resolves `UNDETERMINED` and refuses every lawful Irish
over-the-counter distance sale while reporting that nobody has legislated.

### The pattern PI-17 asked the next phase to carry, on its first outing

⚠️ **A GATE CONDITIONAL ON A FACT THE PLATFORM DOES NOT MODEL — TWICE, IN ONE
PACK.**

1. **`branch.licence_type`, the FOURTH jurisdiction to ask.** Regulation 7(6)
   confines a First Schedule Part C prescription to a hospital. No Part C
   classification is defined, so a Part C product refuses. Defining one with the
   ordinary rules would have been worse than defining nothing.
2. **A prescription's own stated validity.** Regulation 7(5)(a)(ii), from 1 March
   2024, permits up to twelve months where the prescriber wrote a period on the
   prescription or a pharmacist recorded a regulation 9A review. Neither is on
   `PresentedPrescription`, so the pack states limb (i) and refuses on day 183 a
   dispense that may be lawful — a wrong answer in the refusing direction,
   written knowingly, pinned by a behaviour case, and recorded in KNOWN_ISSUES.

### `CountryInfo.regions` — the check that finally came back clean

Third outing of PI-16's "check this list first". `IE` is `[]` and correctly so:
Irish medicines law is national, so no sub-national pack can exist to be made
inert. One loose end recorded rather than fixed blind — `labels.region` says
'County' and no county can be selected; adding twenty-six would also offer them
on the platform's tax-registration screen, and Irish VAT is national.

### Sources, and this pack's largest exposure

⚠️ **IRELAND PUBLISHES NO CONSOLIDATION OF AN S.I.** The 2003 Regulations have
been amended more than forty times; the eISB serves the text of 2003 and each
amendment separately. Three amendments bearing on rules here were read in full
and are their own source rows — S.I. No. 201 of 2007 (nurse prescribers), S.I.
No. 87 of 2015 (regulation 19(5) and 19A), S.I. No. 73 of 2024 (the substituted
validity). The rest were checked for whether they touch regulations 5, 6, 7, 9,
10, 17, 18, 19 or 20. **That is a check, not a guarantee.**

### Three rules that were researched and NOT written

- **Falsified Medicines traceability.** Directly applicable in Ireland;
  `eur-lex.europa.eu` answers `202` on every path. No source, no rule — and
  `evaluateTraceability` REFUSES on a missing identifier while the dispense path
  sends no GTIN, so a rule written from memory would have refused every Irish
  dispense.
- **Controlled-drug container marking.** Regulation 17(1) of the 2017
  Regulations requires it and regulation **17(2)(d) disapplies the whole of it**
  from supply by or on a practitioner's prescription — which is every dispense
  this platform performs.
- **Reporting.** Regulation 24 is on demand, within fourteen days of a written
  demand. There is no periodic return, and a `REPORTING_REQUIREMENT` rule raises
  its condition on every evaluation.

- **DB** n/a — no migration
- **BE** `data/regulatory-ie.ts` (50 rules, 7 sources), one `PACKS` entry;
  `requiresDistanceSellingAuthorisation` + `distanceSellingAuthority` on
  `OnlineDispensingParameters`, parsed in `parameters.ts` and handled in
  `evaluateOnlineDispensing`
- **TEST** 52 behaviour cases in `apps/api/tests/integration/ie-rule-pack.test.ts`,
  including both directions of the remote-supply prohibition, the day-183
  refusal, the Part C `UNDETERMINED`, and the two schedule lists that are not the
  same list
- **DOC** COUNTRY_SUPPORT_MATRIX (IE row + header), KNOWN_ISSUES, CHANGELOG,
  COUNTRY_RULE_PACK_SURVEY, NEXT_SESSION, STATUS
- **Status** COMPLETE ⚠️ **not reviewed** — neither `/code-review` nor the
  security reviewer has run over this diff

### ⚠️ Two defects PI-18 found in code it did not write

**1. `AU-SCHEDULE-S8` refuses every Schedule 8 transaction outside Victoria.**
It carries `{ scheduleName: 'Schedule 8' }` and nothing else;
`parseControlledSchedule` rejects a document that imposes no obligation, so the
rule resolves `UNDETERMINED`, which refuses. Its file comment says the opposite
in so many words, and its behaviour case asserts the rule code appears and no
conditions were raised — exactly what an unreadable rule produces, and it never
asserts the outcome. **Not fixed here**: the fix is a decision about Australia
(delete the rule, or let the parser accept a `scheduleName`-only rule as
informational) that changes behaviour in seven jurisdictions. KNOWN_ISSUES.

**2. An unclassified rule is a fail-open for every classification its pack does
not recognise.** Found in this pack's own first draft — `IE-LABEL-DISPENSE` was
written unclassified, faithfully, and a Part C product then matched only it and
came back `PERMITTED_WITH_CONDITIONS`. Fixed here by writing the labelling rule
once per classification. ⚠️ **`IN`, `US`, `SG` and `US-CA` have the same shape**;
read off the rule rows rather than run, and recorded rather than changed.

**Validation:** ran once at the end, per CLAUDE.md — `pnpm lint`, `pnpm format`,
`turbo typecheck --concurrency=1`, then the tests. ⚠️ `pnpm test` still OOMs the
api container (exit 137, KNOWN_ISSUES #2), so `turbo lint`/`typecheck` ran at
`--concurrency=1` and the api suite ran in six path slices:
**299 unit + 1,747 integration (tenant-isolation included in the `[t-v]` slice,
and 470 again on its own), all green**, plus 25 workspace packages through
`turbo run test` and 120 in `@rcln/regulatory`. `db:rls:check` 131 tables;
`docs:validate` 437/437. No migration, so nothing moved in the schema.

⚠️ **THE SEED UPSERTS AND NEVER DELETES.** Three rule codes were renamed during
the phase (`IE-LABEL-DISPENSE`, `IE-SCHEDULE-CD3`, `IE-SCHEDULE-CD4A`) and their
rows survived a re-seed as orphans. They were deleted from the dev database by
hand. A pack whose codes change between seeds leaves rules nobody wrote still
matching — worth knowing before the next rule-pack phase renames anything.
