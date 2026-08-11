# Changelog

One entry per session. Newest first. Record what changed and why — not what was
discussed.

---

## 2026-08-11 — PI-0: Discovery & Architecture

**Phase:** PI-0 · **Result:** COMPLETE · **Production code changed:** none

### Discovery

Audited the repository directly from source rather than from documentation.
Findings in [CURRENT_STATUS.md](CURRENT_STATUS.md). The consequential ones:

- **Nothing exists.** Zero product, inventory, pharmacy, procurement or
  regulatory tables. This is greenfield.
- **`@rcln/tax` is already global** — `(country, region)` jurisdictions,
  `GST`/`VAT`/`SALES_TAX`, `TaxSplit` for India's halves, effective-dated rules
  with tenant-beats-platform precedence, and a `TaxProviderQuote` seam for US
  sales tax. It needs no change. This removed a large slice of assumed work.
- **`InvoiceSourceType` already has `PHARMACY` and `INVENTORY`.**
- **`invoice_items.item_code` and `.tax_category` are already separate columns**,
  so the brief's "HSN must not be the universal identifier" requirement is
  satisfied upstream.
- **`pharmacy.*` and `inventory.*` permission codes already exist and are
  granted to `PHARMACIST`** — 13 codes, gating nothing, because nothing is built.
- **`specialties` / `qualifications` establish the platform-catalogue-with-
  tenant-extension RLS pattern**, which is exactly the shape the global product
  master needs — including the RESTRICTIVE `*_visible` policy on join tables.
- **`prescriptions` and `encounters`/`procedures` do not exist**, hard-blocking
  the pharmacy-dispensing and clinical-consumption phases. Recorded as KI-1/KI-2.

### Decisions

Seventeen recorded in [ARCHITECTURE.md](ARCHITECTURE.md). Load-bearing:

- **PI-ADR-001** — `products` is the root; medicine is an extension row
- **PI-ADR-002** — the regulatory engine ships **before** dispensing, deviating
  from the brief's suggested order, because dispensing's shape depends on it
- **PI-ADR-003** — the catalogue is a platform master with tenant extension
- **PI-ADR-004** — `stock_ledger` is append-only and is the only quantity truth
- **PI-ADR-005** — consumption never creates an invoice line
- **PI-ADR-006** — this programme writes no tax logic
- **PI-ADR-009** — regulatory maturity is a state, and no agent may set the two
  states that imply legal sign-off

### Planning

- 25 phases (PI-0..PI-24) in [MASTER_PLAN.md](MASTER_PLAN.md), ordered so that
  PI-1..PI-6 are unblocked and can start immediately.
- Task-level tracker for PI-0..PI-5 with a completion gate that is explicitly
  not "the code compiles".
- Eight open decisions, two of which need the user (OD-4 catalogue data source,
  OD-5 who signs off a rule pack).

### Files

Created `.kb/PharmacyInventory/` — 29 documents. Created
`docs/pharmacy-inventory/README.md` as a pointer stub, matching the convention
`docs/README.md` already establishes for every moved document.

**Modified: nothing.** No schema, no package, no app, no migration, no seed.

### Why `.kb/` and not `docs/`

`docs/README.md` states that directory is pointer stubs and says "do not add
content to them". `.kb/` is the KnowledgeBase. `.kb/generate.mjs` only removes
files listed in its own `manifest.json`, so a hand-written directory there is
safe from `pnpm kb`.

### Next

**PI-1.1 — unit of measure & packaging engine.** See
[NEXT_SESSION.md](NEXT_SESSION.md) for the exact starting steps.

---

## Template for the next entry

```markdown
## YYYY-MM-DD — PI-n.m: <what>

**Phase:** · **Result:** · **Tests:** n passing / n failing

### Changed

### Decisions

### Issues found

### Next
```
