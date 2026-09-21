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

`charge_requests.invoice_id` is the only link back, and it is written _by_
invoicing, not by this programme. **Nothing here inserts an `invoice_item`.**

> ⚠️ **CORRECTED BY PI-8: THIS SAID `invoice_item_id`, AND AN ITEM ID CANNOT BE
> THE LINK.** `finalizeInvoice` re-prices a draft from its stored inputs, and
> `repriceLoadedDraft` does that by DELETING every `invoice_items` row and
> writing them again — so the id a charge cited at creation is gone by the time
> the document is issued. A foreign key onto it either blocks finalisation
> outright or silently detaches at the moment it starts to matter; the first
> implementation had the FK and finalisation raised on it. `invoice_id` is stable
> for the life of the document, and the LINE is recoverable by position because
> `createDraftInvoice` numbers lines by array index.

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

> ⚠️ **PI-8 BUILT THREE OF THESE EIGHT TIERS, AND THE OTHER FIVE NAME ENTITIES
> THAT DO NOT EXIST.** There is no `procedures` table — that is PI-9, blocked on
> `encounters` — and no payer-contract model anywhere in this repository.
> Building a resolver tier against a table whose shape has to be guessed at is
> the mistake PI-5 records about `regulatory_decisions`, so `product`,
> `product category`, `product type` and `default` are implemented and
> `ChargePolicyScope` is where the rest go when their entities arrive.
>
> ⚠️ **THE CATEGORY TIER WALKS NO ANCESTRY.** A rule on "Antibiotics" does not
> reach a product filed under its child "Penicillins": `product_categories` is a
> recursive tree with no depth limit, an ancestry walk is a recursive CTE per
> line inside the posting transaction, and "which ancestor won?" is a question a
> clinic cannot answer from the screen.

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

A dispensing return produces a **credit note**. It never edits the original
invoice — the lifecycle guard would refuse, and correctly: an issued invoice may
have been claimed against insurance.

> ⚠️ **"THROUGH THE EXISTING ENGINE" WAS NOT TRUE WHEN THIS WAS WRITTEN.** There
> was no credit-note table, no series and no `CREDIT_NOTE` kind —
> `voidInvoice`'s header records the gap as deliberate. **PI-8 built it**, as an
> `invoices` row with `kind: CREDIT_NOTE` and its own consecutive `CRN-` series,
> so it inherits `invoices_lifecycle_guard` instead of needing a second copy of
> the hardest trigger in the engine.
>
> What a return actually does depends on whether the charge reached a bill.
> **Unbilled:** the original charge request is CANCELLED — nothing was owed, so
> nothing is credited. **Billed:** a REVERSAL charge request stays pending and a
> credit note reverses it. A PARTIAL return leaves the original standing at its
> full quantity; rewriting it would lose the fact that ten were supplied.
>
> ⚠️ **A CREDIT NOTE STILL MOVES NO MONEY.** It is the DOCUMENT saying the clinic
> owes the patient; the refund is a payment, and there is no patient-payments
> table yet.

---

## Counter sales

A pharmacy counter sale with no prescription and possibly no patient. It creates
a charge request with `patient_id = NULL` and flows through the same path. The
invoice engine already supports an invoice with no clinical source; `OTHER` and
`PHARMACY` are both existing `InvoiceSourceType` members.

**This path was not blocked by `prescriptions`** — but it shipped with PI-7
regardless, through the same `POST /v1/dispenses` endpoint, because a counter
sale and a prescription supply differ only in whether a prescription was
presented. PI-8 bills both through one path.

⚠️ `invoices.customer_name` is NOT NULL, so a counter sale with no patient is
billed to "Counter sale" and the cashier types a name over it if the customer
wants one. Inventing a patient record to hold a paracetamol sale is exactly what
`dispenses.patient_id` is nullable to avoid.

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
