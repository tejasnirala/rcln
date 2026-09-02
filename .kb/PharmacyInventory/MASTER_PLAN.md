# Master Plan

The phases, their order, and the reasoning behind the order. Task-level detail
lives in [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md).

Phases are prefixed `PI-` so they never collide with the repository's own
phase numbering in `.kb/STATUS.md`. This whole programme is what that document
calls "Phase 5 — Pharmacy and inventory".

---

## Ordering principles

1. **Nothing depends on what does not exist.** PI-1..PI-6 touch no Phase 3
   entity, so they can proceed while Core Clinical is still being built.
2. **Seams before workflows.** The regulatory engine ships _before_ dispensing,
   not after it. Inserting a rule engine underneath a live dispensing
   transaction is a rewrite of that transaction and every test around it.
3. **The database is capable before the workflow exists.** Recall, quarantine,
   serialisation and traceability columns land in PI-2 even though the recall
   _workflow_ is PI-10. A recall you cannot execute is an inconvenience; a
   recall the schema cannot represent is a migration under load.
4. **Every phase is a vertical slice.** Schema + RLS → contracts → permissions →
   service → route → screen → tests. No phase is "backend only".
5. **One country validates the framework.** India (PI-6) is the pilot rule pack
   because the tax engine, invoice numbering and the existing domain model are
   already India-aware. The other nine follow the same shape or the framework
   is wrong.

---

## Deviation from the brief's suggested order

The brief suggested Pharmacy (Phase 4) before the Regulatory Framework
(Phase 7). **This plan swaps them**: regulatory framework is PI-5 and pharmacy
dispensing is PI-7.

Two reasons. First, dispensing must call `evaluateDispense(...)` — prescription
requirement, controlled-substance handling, quantity limits, substitution
permission — and those calls are the _shape_ of the dispensing transaction, not
a decoration on it. Second, PI-7 was hard-blocked on `prescriptions` at the time, so
the slot is free. This is recorded as **PI-ADR-002**.

The brief's other ordering guidance is followed: the framework precedes country
packs, and country packs are incremental.

---

## The phases

### PI-0 — Discovery & Architecture ✅ COMPLETE

Repository audit, integration-seam identification, architecture decisions,
documentation and tracker. Output is this directory. No production code.

---

### PI-1 — Product Platform Core

**Not blocked. This is the next phase.**

The catalogue: what a thing _is_. No stock, no quantity, no location.

- Unit of measure + packaging hierarchy engine, with a base unit and conversions
- `products` — the root entity, `ProductType` discriminator over 12+ types
- Product categories, reusing the `parent_id`-only taxonomy shape
- Manufacturers
- Active ingredients → compositions → products (the generic/brand triangle)
- Medicine attributes: dosage form, route, release type, strength per ingredient
- Product identifiers — GTIN/EAN/UPC/NDC/SKU/local, jurisdiction- and type-aware
- Product tax classification per jurisdiction, resolving to a `tax_category`
- Storage requirement profiles
- Inventory configuration on the product (tracking mode, base unit, shelf life)
- Screens: product list with fast search, create/edit wizard, product detail
- Tests: unit conversion algebra, identifier uniqueness, RLS isolation

Deliberately _excluded_: anything with a quantity.

---

### PI-2 — Inventory Foundation

Where stock is and how much. Still no movement workflows.

- Inventory location hierarchy below branch (store → area → rack/shelf/bin)
- `batches` — lot, mfg/expiry/retest dates, cost, supplier, manufacturer, status
- `serials` — individually identified units
- `stock_ledger` — append-only, the only source of quantity truth
- `stock_balances` — trigger-maintained cache, never authoritative
- Inventory status: `AVAILABLE`/`RESERVED`/`QUARANTINED`/`BLOCKED`/`EXPIRED`/
  `DAMAGED`/`RECALLED`/`DISPOSED`, kept distinct from product status
- Configurable expiry thresholds via the settings resolver; a worker sweep
- Recall/quarantine columns present, workflow deferred to PI-10
- Screens: inventory dashboard, stock by location, batch view, serial view,
  expiry view, ledger view
- Tests: ledger/balance agreement under concurrency, RLS isolation, FEFO ordering

---

### PI-3 — Movements

- Adjustments with a mandatory reason code
- Transfers: intra-branch (location → location) and inter-branch
- Reservations — the `RESERVED` status made real
- FEFO allocation service, with jurisdictional and product-level overrides
- Screens: transfers, adjustments, reservation view
- Tests: transfer atomicity, no negative balances, reservation release

---

### PI-4 — Procurement

- Suppliers, supplier products (supplier-specific SKUs, pack sizes, prices)
- Purchase requisitions → purchase orders → goods receipts → purchase returns
- Batch and serial capture at receipt
- Quality / acceptance step
- Costing: purchase cost, moving average, cost per base unit
- Screens: supplier list/detail, PO workspace, GRN capture, returns
- Tests: receipt writes ledger, cost roll-up, over-receipt refusal

---

### PI-5 — Global Regulatory Framework

No country rules. The machine that runs them.

- `jurisdictions`, `regulatory_authorities`
- `regulatory_rule_packs` — versioned, effective-dated, with a maturity state
- `product_regulatory_profiles` — one product, many jurisdictions
- `regulatory_sources` — the source registry (authority, URL, published,
  effective, retrieved, review status)
- The evaluation contract: a pure function over
  `(product, jurisdiction, transaction, actor, prescription?) → decision`
  in a new `@rcln/regulatory` package, mirroring how `@rcln/tax` is pure
- Screens: jurisdiction config, product regulatory profile, rule status/version,
  source references
- Tests: rule resolution, version selection by date, no-rule → refuse not guess

---

### PI-6 — India Rule Pack (pilot)

The first country. Proves the framework or breaks it.

Scope: prescription classification, Schedule H/H1/X handling, record retention,
labelling fields, online dispensing position, quantity limits. Every rule cites
a source in `regulatory_sources`. Ships at maturity `RULES_IMPLEMENTED` +
`AUTOMATED_TESTED`, **never** `REGULATORY_REVIEWED` — that state is set by a
human with the authority to set it.

---

### PI-7 — Pharmacy Dispensing ✅ COMPLETE (2026-08-16)

- Prescription queue, pharmacist verification
- Regulatory validation via PI-5
- Stock availability, generic/brand substitution where permitted
- Batch allocation (FEFO), dispensing, dispensing ledger entries
- Returns, OTC counter sales
- Screens: pharmacy dashboard, prescription queue/detail, dispensing workspace,
  batch selection, substitution flow, returns, sales
- Tests: cannot dispense expired/recalled/quarantined stock; controlled-product
  path; RBAC; PHI read logging

---

### PI-8 — Billing & Tax Integration

- `charge_requests` — the structured hand-off, with a charge policy
- Charge policy resolution: `NEVER_BILL` / `INCLUDED_IN_SERVICE` /
  `SEPARATELY_BILLABLE` / `OPTIONAL` / `CONTRACT_DEFINED` / `JURISDICTION_CONFIGURED`
- Wiring `InvoiceSourceType.PHARMACY` and `.INVENTORY` end to end
- Product → jurisdiction → `tax_category` resolution
- Screens: charge review before invoicing; the existing invoice screens do the rest
- Tests: a consumed glove produces no invoice line; an implant does; tax
  resolves through the existing engine and nowhere else

⚡ It did not: the counter-sale path shipped WITH PI-7, through the same
endpoint, because the two differ only in whether a prescription was presented.
PI-8 now has both paths waiting for it.

---

### PI-9 — Clinical Consumption ⛔ BLOCKED on `encounters` / `procedures`

- Consumption templates per procedure
- Expected vs actual, with clinician override and an audit trail
- Inventory movement on actual consumption
- Dental, veterinary, lab and general use of the same engine
- Screens: procedure consumption panel, expected-vs-actual, consumption history,
  inventory impact
- Tests: override audited; consumption never auto-creates an invoice line

---

### PI-10 — Recall & Traceability

- Recall workflow: identify product → batch/serial → locations → quarantine →
  block dispensing → identify affected dispensing and consumption records
- Forward and backward traceability queries
- Screens: recall create/execute, affected-stock view, traceability report
- Tests: a recalled batch cannot be dispensed or consumed, from every path

---

### PI-11 — Veterinary Enablement

Additive. `patients` gains a subject type; an animal profile table hangs off it.
The product and inventory engines are untouched — only regulatory profiles and
dosing differ.

---

### PI-12 — Online Pharmacy

Order → prescription → regulatory + jurisdiction validation → allocation →
dispensing → billing → packing → shipping → delivery. Gated entirely by
regulatory configuration; no product is onlineable by default.

---

### PI-13 … PI-21 — Country Rule Packs

In order: **US** (federal + state-extensible; also exercises the
`TaxProviderQuote` seam), **UK**, **Australia**, **Singapore**, **UAE**,
**Ireland**, **Nepal**, **Sri Lanka**, **Bangladesh**.

Each pack: research → rules + sources → tests → matrix update → maturity state.

---

### PI-22 — Reporting & Cost Accounting

Stock valuation, aging, movement, dead stock, consumption cost, procedure
contribution (revenue − consumable cost), supplier performance, dispensing,
recall and quarantine reports.

---

### PI-23 — Identifier Resolution & Barcode/GS1 · shipped 2026-09-02

A generic decode → resolve → act layer. A scan may carry GTIN + lot + expiry +
serial in one string; the resolver returns a product _and_ a batch _and_ a
serial, not just a product.

Shipped as `decodeScan` in `@rcln/inventory`, `GET /v1/stock/resolve`, a scanner
console at `/stock/scan` and scan-to-fill on the goods receipt — plus the search
pickers that removed every capped `<select>` in `apps/web`. No migration.

---

### PI-24 — Global Hardening

Security review, performance and index audit, E2E coverage, data migration
rehearsal, documentation, production readiness gates.

---

## Dependency graph

```text
PI-1 ─┬─▶ PI-2 ─┬─▶ PI-3 ─┬─▶ PI-4
      │         │         │
      │         │         └─▶ PI-10 (recall workflow)
      │         │
      │         └─────────────▶ PI-22 (reports)
      │
      └─▶ PI-5 ─▶ PI-6 ─▶ PI-13..PI-21

PI-3 + PI-5 + encounter_prescriptions ─▶ PI-7 ─▶ PI-8 ─▶ PI-12
PI-3 + [encounters/procedures] ─▶ PI-9 ─▶ PI-8

PI-11, PI-23 independent once PI-1/PI-2 land.
PI-24 last.
```

## Rough sizing

Not commitments. Relative effort only.

| Phase     | Size   | Notes                                                                     |
| --------- | ------ | ------------------------------------------------------------------------- |
| PI-1      | L      | The unit engine and the generic/brand triangle are the hard parts         |
| PI-2      | XL     | The ledger/balance contract is the single most important thing built here |
| PI-3      | M      |                                                                           |
| PI-4      | L      |                                                                           |
| PI-5      | L      | Design-heavy, low table count                                             |
| PI-6      | M      | Research-heavy, code-light                                                |
| PI-7      | XL     | Done. Still the highest-risk workflow in the programme                    |
| PI-8      | M      | Mostly wiring, because the engines exist                                  |
| PI-9      | L      | Blocked                                                                   |
| PI-10     | M      |                                                                           |
| PI-11     | S      |                                                                           |
| PI-12     | L      |                                                                           |
| PI-13..21 | S each | Research-dominated                                                        |
| PI-22     | L      |                                                                           |
| PI-23     | M      |                                                                           |
| PI-24     | L      |                                                                           |
