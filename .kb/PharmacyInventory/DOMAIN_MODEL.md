# Domain Model

The conceptual entities and — more importantly — the boundaries between them.
Table-level detail is in [DATABASE_MODEL.md](DATABASE_MODEL.md).

---

## The ten domains

Each answers exactly one question. A service that answers two of them is
already wrong.

| Domain                   | Question                           | Owns                                                                                                                        |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Product**              | _What is it?_                      | products, compositions, ingredients, manufacturers, units, packaging, identifiers, tax classification, storage requirements |
| **Inventory**            | _Where and how much exists?_       | locations, batches, serials, ledger, balances, statuses                                                                     |
| **Procurement**          | _How did we acquire it?_           | suppliers, supplier products, requisitions, POs, GRNs, returns, cost                                                        |
| **Pharmacy**             | _How was medicine dispensed?_      | prescription queue, verification, substitution, dispensing, returns, counter sales                                          |
| **Clinical consumption** | _Why was it used?_                 | templates, expected vs actual, overrides                                                                                    |
| **Regulatory**           | _What rules apply?_                | jurisdictions, authorities, rule packs, product profiles, sources, decisions                                                |
| **Traceability**         | _Where has it been?_               | queries over the ledger; owns no tables of its own                                                                          |
| **Billing**              | _Should the patient be charged?_   | charge requests, charge policy — **existing engine does the invoicing**                                                     |
| **Tax**                  | _What tax applies?_                | **entirely `@rcln/tax`.** This programme contributes a category string.                                                     |
| **Audit**                | _Who did what, and who read what?_ | **entirely existing.** `recordAudit` + `recordDataAccess`.                                                                  |

---

## Product

### The generic/brand triangle

The single most important shape in the catalogue. It is what makes "is there an
equivalent in stock?" and "may I substitute?" answerable at all.

```text
        active_ingredients
                │  (many-to-many, with strength + strength unit
                │   on the join — a medicine is never one ingredient)
                ▼
        composition_ingredients
                │
                ▼
          compositions ────────┐
                │              │
     ┌──────────┼──────────┐   │  a composition is a NAMED set of
     ▼          ▼          ▼   │  ingredients at strengths.
  Brand A    Brand B   Generic │  Products reference it.
  (product)  (product) (product)
```

`compositions` is nullable on `products`: a glove has no composition. That
nullability is the discriminator between "catalogue item" and "medicinal
product", and it is more honest than a boolean.

### Product vs everything downstream

```text
products              "Amoxicillin 500 mg capsule, Brand A, by Manufacturer M"
   │                   — definition. No quantity. No location. No price.
   ├── product_packagings        box(10) → strip(10) → capsule
   ├── product_identifiers       GTIN, NDC, internal SKU, per jurisdiction
   ├── product_tax_classifications  per jurisdiction → tax_category
   ├── product_regulatory_profiles  per jurisdiction (PI-5)
   ├── medicine_details          dosage form, route, release type
   └── storage_requirement       2–8 °C, protect from light
        │
        ▼
   batches               "lot AX-2291, expires 2027-03, cost ₹4.10/capsule"
        │
        ▼
   stock_ledger          "+1000 capsules into Main Pharmacy on GRN-000123"
```

### Type system

`ProductType` — `MEDICINE`, `VACCINE`, `CONSUMABLE`, `SURGICAL_SUPPLY`,
`MEDICAL_DEVICE`, `IMPLANT`, `DENTAL_MATERIAL`, `LAB_REAGENT`,
`DIAGNOSTIC_KIT`, `VETERINARY_MEDICINE`, `VETERINARY_CONSUMABLE`,
`GENERAL_CLINICAL_SUPPLY`. Open by design; adding a member is a migration, not a
redesign.

⚠️ **Type is metadata, not authorization.** Do not gate a permission on it. The
same trap `TaxonomyNodeType` already carries a warning about.

---

## Inventory

### The three layers

```text
LEDGER      append-only, one row per movement. THE TRUTH.
   ↓ trigger
BALANCE     (product, batch?, serial?, location, status) → quantity. A CACHE.
   ↓ query
VIEW        "what is available in Main Pharmacy" — never stored.
```

### Location hierarchy

```text
organization
   └── branch                    ← the RLS boundary and the tax place of supply
         └── inventory_location  ← "Main Pharmacy", "Vaccine Fridge", "CD Cabinet"
               └── storage_area  ← "Cold room A"
                     └── bin     ← "Rack 3 / Shelf 2 / Bin 11"
```

Areas and bins inherit tenancy through composite FKs; only `inventory_location`
is separately branch-scoped. See PI-ADR-012.

### The three statuses that get confused

| Concept        | Column                  | Example                                      |
| -------------- | ----------------------- | -------------------------------------------- |
| Product status | `products.status`       | `DISCONTINUED` — we no longer stock this     |
| Batch status   | `batches.status`        | `RECALLED` — this lot is unsafe              |
| Balance status | `stock_balances.status` | `RESERVED` — allocated to a pending dispense |

All three are independent. A `DISCONTINUED` product with an `ACTIVE` batch in
`AVAILABLE` status is normal and must remain dispensable.

---

## Procurement

```text
supplier ──< supplier_products (their SKU, their pack, their price)
    │
    └──< purchase_requisition ──▶ purchase_order ──< po_lines
                                        │
                                        ▼
                                  goods_receipt ──< grn_lines
                                        │              │
                                        │              ├── batch capture
                                        │              └── serial capture
                                        ▼
                                   stock_ledger  (+qty, cost, reference=GRN)
```

A purchase return is a ledger movement with a reference back to the GRN line,
not a deletion of the receipt.

**Cost enters the system here and nowhere else.** `batches.unit_cost_base` is
set at receipt and never re-derived from a price list.

---

## Pharmacy

Pharmacy is a **workflow over product + inventory + regulatory**. It owns no
quantity and no rate.

```text
prescription (Phase 3, read-only to pharmacy)
      │
      ▼  verify pharmacist authority
regulatory decision  ← @rcln/regulatory
      │
      ▼  what is in stock, and what may substitute for it
allocation (FEFO)
      │
      ▼
dispensing record ──▶ stock_ledger (DISPENSING movement)
      │
      └──▶ charge_request ──▶ existing billing/tax/invoice/payment engines
```

⚠️ **Invariant 7 holds here.** Pharmacy reads the prescription; it never writes
one. `clinical.prescription.create` / `.sign` remain DOCTOR-only.

---

## Clinical consumption

```text
encounter → procedure → consumption_template (expected)
                              │
                              ▼
                     clinician adjusts → actual consumption
                              │
              ┌───────────────┴────────────────┐
              ▼                                ▼
        stock_ledger                    charge_request
     (CLINICAL_CONSUMPTION)         (only if charge policy says so)
```

The right-hand branch is frequently empty, and that is correct. See
[CLINICAL_CONSUMPTION.md](CLINICAL_CONSUMPTION.md).

---

## Regulatory

```text
jurisdiction (country, region?)
   └── regulatory_authority
         └── regulatory_rule_pack (version, effective dates, maturity)
               └── regulatory_rule (typed: PRESCRIPTION_REQUIRED,
                     CONTROLLED_SCHEDULE, QUANTITY_LIMIT, SUBSTITUTION,
                     ONLINE_DISPENSING, STORAGE, RETENTION, LABELLING,
                     TRACEABILITY, REPORTING, AGE_RESTRICTION)
                     └── regulatory_source (authority, URL, dates, review state)

product ──< product_regulatory_profiles >── jurisdiction
              (registration, classification, schedule, restrictions)
```

The evaluation is a pure function. See
[REGULATORY_ARCHITECTURE.md](REGULATORY_ARCHITECTURE.md).

---

## Boundaries that must not blur

| Tempting merge                              | Why it is wrong                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Put `quantity` on `products`                | A product exists in many places at many statuses. One number cannot say that.           |
| Put `price` on `products`                   | Price is per payer, per contract, per jurisdiction and per date. It belongs to billing. |
| Let dispensing insert an invoice line       | PI-ADR-005. Breaks every non-billable consumable.                                       |
| Let pharmacy compute GST                    | PI-ADR-006. There is a tested engine for it.                                            |
| Give consumables their own inventory        | PI-ADR-001. Two ledgers means one neglected ledger.                                     |
| Make `products.type` an authorization input | Metadata, not a permission.                                                             |
| Store the recall decision on `products`     | A recall is per batch. PI-ADR-013.                                                      |
| Mutate `stock_balances` directly            | PI-ADR-004. It is a cache.                                                              |
