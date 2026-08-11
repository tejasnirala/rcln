# Billing Integration

**This programme implements no invoicing.** rcln already has a billing engine, a
tax engine, an invoice engine and a payment engine, all working end to end for
appointment invoicing. Pharmacy and inventory hand work to them.

---

## What already exists

| Piece                                                                | Where                       | State    |
| -------------------------------------------------------------------- | --------------------------- | -------- |
| `invoices` / `invoice_items` / `invoice_taxes` / `invoice_documents` | schema                      | Complete |
| `InvoiceSourceType` — **already has `PHARMACY` and `INVENTORY`**     | schema                      | Complete |
| DRAFT-only money mutation, enforced by `invoices_lifecycle_guard`    | migration                   | Complete |
| Per-branch, per-source, per-period numbering                         | `invoice-number.service.ts` | Complete |
| Line arithmetic, discounts, apportionment                            | `@rcln/invoicing`           | Complete |
| `Money` in integer minor units                                       | `@rcln/payments`            | Complete |
| Invoice services, incl. `createInvoiceForAppointment`                | `services/invoicing/`       | Complete |
| Invoice visibility by module                                         | `invoice-visibility.ts`     | Complete |

`appointment-billing.service.ts` is the **template**: a clinical domain that
knows what happened and hands a structured request to invoicing. Pharmacy and
consumption follow its shape.

---

## The seam

```text
dispensing / consumption / counter sale
              │
              ▼
        charge_request                  ← this programme owns this
   product · quantity · unit · patient? · source · branch · occurred_at
              │
              ▼
      charge policy resolution          ← this programme owns this
              │
    ┌─────────┴──────────┐
    ▼                    ▼
SUPPRESSED          BILLABLE
(no invoice)             │
                         ▼
          services/invoicing               ← EXISTS. Not modified.
          createInvoiceFor…(source = PHARMACY | INVENTORY)
                         │
                         ▼
                  @rcln/tax               ← EXISTS. Not modified.
                         │
                         ▼
                 invoice + PDF            ← EXISTS. Not modified.
                         │
                         ▼
                @rcln/payments            ← EXISTS. Not modified.
```

`charge_requests.invoice_item_id` is the only link back, and it is written _by_
invoicing, not by this programme. **Nothing here inserts an `invoice_item`.**

---

## Charge policy

The question is _should this reach a bill at all_, and it is separate from
consumption (PI-ADR-005).

| Policy                    | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `NEVER_BILL`              | consumed, never charged — gloves, disinfectant               |
| `INCLUDED_IN_SERVICE`     | consumed, its cost is inside the procedure fee — anaesthetic |
| `SEPARATELY_BILLABLE`     | its own invoice line — an implant, a dispensed medicine      |
| `OPTIONAL`                | a human decides at the charge-review step                    |
| `CONTRACT_DEFINED`        | the payer contract decides                                   |
| `JURISDICTION_CONFIGURED` | the regulatory/tax configuration decides                     |

### Resolution

Most specific wins, evaluated in this order and stopping at the first match:

```
product + procedure + payer
product + procedure
product + payer
product
product category + procedure
product category
product type
default (NEVER_BILL for consumables, SEPARATELY_BILLABLE for medicines)
```

The resolved policy and the rule that produced it are **stored on the charge
request**, so an old bill can still explain itself after the policy changes.

---

## Pricing

Charge price is not inventory cost, and neither is derived from the other
(PI-ADR-010). Selling price resolution reuses the existing fee-schedule pattern
(`FeeScheduleEntry`, `pricing.service.ts`) rather than growing a second one:
org default → branch override → payer contract → manual override at the counter.

`billing.fee_schedule.manage` gates product pricing, for the same reason it
gates consultation fees — a price is a commercial position, and the existing
catalogue already documents why that is not a settings code.

---

## Invoice construction

The charge-request → invoice step passes, per line:

```
description        the product name, as the patient should see it
item_code          the printed HSN/SAC, from product_tax_classifications
tax_category       the exact-match key into tax_rules      ← see TAX_INTEGRATION
quantity           Decimal(14,3), in the SALE unit not the base unit
unit_price         Money, integer minor units
source_type        PHARMACY | INVENTORY
source_id          the dispense / consumption record
```

Everything after that — discounts, apportionment, tax lines, totals, numbering,
the PDF — is the existing engine's work.

⚠️ `invoice_items.quantity` is `Decimal(14,3)` and the ledger is `Decimal(18,6)`.
The conversion happens at this boundary and is deliberate: the charge quantity
is a coarser, human-facing number ("2 strips"), and `invoice_items` is a frozen
column on an issued document.

---

## Returns and corrections

A dispensing return produces a **credit note** through the existing engine. It
never edits the original invoice — the lifecycle guard would refuse, and
correctly: an issued invoice may have been claimed against insurance.

---

## Counter sales

A pharmacy counter sale with no prescription and possibly no patient. It creates
a charge request with `patient_id = NULL` and flows through the same path. The
invoice engine already supports an invoice with no clinical source; `OTHER` and
`PHARMACY` are both existing `InvoiceSourceType` members.

**This path is not blocked by `prescriptions`**, so it can ship in PI-8 ahead of
PI-7.

---

## Rules

- Never insert into `invoice_items`, `invoice_taxes` or `invoices` from this
  programme.
- Never compute a tax amount, split a tax line or name a tax.
- Never edit an issued invoice.
- Never let consumption create a charge as a side effect — the charge request is
  a separate, reviewable record.
- Never use a float for money.
- Do add pharmacy and inventory sources to `invoice-visibility.ts` so a
  pharmacist holding `pharmacy.dispense.read` sees pharmacy invoices, which is
  exactly what that module already does for lab and appointments.
