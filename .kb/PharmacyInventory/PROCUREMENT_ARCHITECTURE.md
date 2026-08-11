# Procurement Architecture

Phase PI-4. How stock enters the system, and where cost comes from.

---

## The chain

```text
supplier ──< supplier_products          their SKU, their pack, their price
    │
    ├──< purchase_requisition ──approve──▶ purchase_order ──< po_lines
    │      (a branch asks)                  (the org commits)
    │
    └──────────────────────────────────▶ goods_receipt ──< grn_lines
                                              │              │
                                              │              ├── lot capture
                                              │              ├── expiry capture
                                              │              └── serial capture
                                              ▼
                                     stock_ledger  PURCHASE_RECEIPT
                                              │
                                              ▼
                                     batches (cost per base unit)
```

A purchase return is a `RETURN`-signed movement citing the GRN line, never a
deletion of the receipt.

---

## Supplier products are the translation layer

A supplier sells "AMOX-500-BOX10x10" in cases of 5 boxes at ₹412 per box. The
clinic stocks "Amoxicillin 500 mg capsule" in capsules.

`supplier_products` holds that mapping: supplier SKU, supplier pack unit,
quantity per pack, price per pack, currency, lead time, minimum order quantity.
The unit engine (PI-1.1) converts to base units.

Without this table, every PO line re-enters a conversion by hand and every one
of them is a chance to order ten times too many.

---

## Goods receipt is where the truth enters

The GRN is the most consequential screen in this phase, because it is where
facts about physical stock are first recorded and where they are hardest to
correct later:

- lot number, manufacturing date, expiry date, retest date
- serial numbers, where the product's tracking mode requires them
- actual received quantity, which may differ from ordered
- unit cost, which sets `batches.unit_cost_base`
- manufacturer, which may differ from the product's default

Enforcement at receipt:

- **The product's tracking mode is enforced here** (PI-ADR-014). A `SERIAL`
  product cannot be received without serials — a CHECK, not a validation.
- An expiry-controlled product cannot be received without an expiry date.
- Over-receipt beyond a configured tolerance is refused; the tolerance is a
  setting, not a constant (PI-ADR-015).
- Receiving an expired batch is refused outright.

---

## Quality / acceptance

An optional hold between receipt and availability. Received stock lands in
`QUARANTINED` and an acceptance step moves it to `AVAILABLE`, or to `DAMAGED` /
returns.

Whether the hold is mandatory is a **setting** per branch or per product
category. Some clinics inspect everything; most inspect vaccines and implants.

---

## Costing

- `batches.unit_cost_base` — integer minor units per **base unit**, with a
  currency. Set once at receipt.
- Landed cost — freight, duty, handling — is apportioned across the GRN's lines
  pro-rata by value if the clinic records it. The apportionment is stored, not
  re-derived, exactly as invoice discount apportionment already is.
- A moving average per (product, branch) is maintained for valuation.
- **The purchase price is not the selling price.** Neither is derived from the
  other. See [BILLING_INTEGRATION.md](BILLING_INTEGRATION.md).

Tax on a _purchase_ is input tax and is a different question from tax on a
_sale_. This programme records what the supplier charged; it does not compute
it, and input-tax credit is out of scope. Recorded, not calculated.

---

## Numbering

Requisition, PO, GRN and return numbers all come from the existing
`issueNumber()` with new `NumberSequenceType` members. Gapless, per branch, and
transactional — a PO whose transaction rolls back burns no number.

⚠️ Do **not** add a branch RLS policy to `number_sequences`. The schema already
explains why: `ON CONFLICT DO UPDATE` against an RLS-hidden row raises 23505
instead of incrementing, turning a scope problem into a mystifying error at the
moment of use.

---

## Supplier tax identifiers

`supplier_tax_identifiers` records the supplier's GSTIN / VAT number / TIN per
jurisdiction, using the same `(country_code, region_code)` vocabulary the tax
engine already speaks. It is recorded for the purchase document and for supplier
reporting. It does **not** feed `@rcln/tax`, which prices _sales_.

---

## Permissions

Existing codes cover most of it: `pharmacy.supplier.manage`,
`pharmacy.purchase_order.read` / `.manage`, `pharmacy.goods_receipt.manage`.

Two additions are needed: `procurement.requisition.create` and
`procurement.requisition.approve` — split so a branch cannot approve its own
request, mirroring the existing `doctor.schedule.request` / `.approve` split.
