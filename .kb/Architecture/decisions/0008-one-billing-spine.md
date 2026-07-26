# ADR-0008 — One invoice system, not one per module

**Status:** Accepted

## Context

The predecessor had two parallel billing systems — `transaction.invoices` for
consultations and `pharmacy.invoices` for dispensing — plus
`transaction.invoice_items.items` storing line items as a **JSON blob**.

Consequence: "how much has this clinic earned" could not be answered correctly,
because it meant unioning two schemas and parsing JSON.

## Decision

One `invoices` table with typed `invoice_items`, covering consultations,
procedures, lab tests and pharmacy dispensing. `source_type` plus nullable
`appointment_id` / `encounter_id` / `dispense_id` / `lab_order_id` records where
a charge came from.

Line items are rows, never JSON. Each carries `doctor_profile_id` so revenue
attribution is recorded rather than inferred.

Platform subscription billing is entirely separate (`subscription_invoices`). A
clinic's revenue and the clinic's bill to us must never share a table.

## Consequences

- Dashboard earnings is `sum(total_amount)` over one table.
- Revenue by doctor and by module are group-bys, not joins across systems.
- `payment_allocations` rather than `payments.invoice_id`, so one payment can
  settle several invoices and advances can be applied later.
- `number_sequences` generalises invoice numbering to every document type
  (invoice, appointment, MRN, PO, GRN, lab order) with financial-year reset,
  which GST compliance requires.
- India-specific: `invoice_tax_lines` splits CGST/SGST/IGST, and `tax_rates` is
  date-versioned so historical invoices reprint at the rate that applied.

## How it can be broken

Adding a module-specific invoice table because "pharmacy billing is different".
It is not; it is a different `item_type`.
