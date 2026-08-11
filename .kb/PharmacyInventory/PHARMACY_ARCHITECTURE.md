# Pharmacy Architecture

**Phase PI-7 — hard-blocked on `prescriptions`, which does not exist.**
Phase 3 (Core clinical) owns that model and has not built it. This document is
the design, written now so PI-1..PI-5 build the seams it needs.

Pharmacy is a **workflow over product + inventory + regulatory**. It owns no
quantity, no rate and no clinical content.

---

## Invariant 7 applies here

`clinical.prescription.create` and `.sign` are DOCTOR-only and are explicitly
stripped from ORG_OWNER and ORG_ADMIN in `roles.ts`. **Pharmacy reads a
prescription; it never writes one.** A pharmacist who needs a change requests it
from the prescriber — that is a workflow, not a permission.

The one thing pharmacy writes against a prescription is its own dispensing
record, which is a separate table with a foreign key.

---

## The dispensing flow

```text
prescription (read-only)
      │
      ▼
[1] prescription validation      is it current, signed, not already dispensed?
      │
      ▼
[2] regulatory validation        @rcln/regulatory.evaluate(...)
      │                          prescription required · prescriber authority ·
      │                          pharmacist authority · quantity limit ·
      │                          refill rules · controlled handling ·
      │                          substitution permitted · age restriction
      ▼
[3] stock availability           per product, per location, AVAILABLE only
      │
      ▼
[4] product / generic selection  the composition triangle answers "what else"
      │                          — but [2] answers "may I"
      ▼
[5] batch allocation             FEFO + overrides, plan returned before commit
      │
      ▼
[6] pharmacist verification      a human confirms the plan
      │
      ▼
[7] dispensing                   one transaction:
      │                            dispense record
      │                          + stock_ledger rows (DISPENSING)
      │                          + regulatory_decision snapshot
      │                          + audit row + data_access row
      ▼
[8] charge_request               structured hand-off — NOT an invoice line
      │
      ▼
    existing Billing → Tax → Invoice → Payment engines
```

Steps 2 and 8 are the two seams that make this design worth having. Everything
between them is ordinary inventory work.

---

## Regulatory validation is not optional and not inline

Pharmacy calls `evaluate()` and reads the decision. It does not read a rule row,
does not know a country code, and contains no `if (country === …)`.

The decision is **snapshotted** onto the dispensing record (PI-ADR-008): rule
pack id, version, outcome, reasons. Re-running the engine over a two-year-old
dispense must never be necessary and must never change what it says.

A refusal renders its `reason` verbatim to the pharmacist. A `422`, never a
`403` — see [API_ARCHITECTURE.md](API_ARCHITECTURE.md) § Errors.

---

## Substitution

Two independent questions, and conflating them is the classic error:

| Question               | Answered by                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| _What is equivalent?_  | The composition triangle — same `composition_id`, in stock, not expired                                 |
| _May I substitute it?_ | `@rcln/regulatory` — per jurisdiction, per product classification, sometimes per prescriber instruction |

A product being equivalent does not make it substitutable. Some jurisdictions
permit generic substitution by default, some require prescriber consent, some
forbid it for narrow-therapeutic-index medicines — hence
`medicine_details.is_narrow_therapeutic_index` in PI-1.5.

**No substitution rule is hard-coded globally.** The default in the absence of a
rule is _do not substitute_, consistent with PI-ADR-007.

---

## Counter sales (OTC)

A sale with no prescription. Same flow minus steps 1 and 4, with step 2 doing
the heavy lifting: the regulatory engine decides whether this product may be
sold without a prescription in this jurisdiction. That is the _entire_ OTC
concept — there is no `is_otc` boolean on the product, because the same product
is OTC in one country and prescription-only in another.

**Counter sales are not blocked by `prescriptions`**, so this path can ship in
PI-8 ahead of PI-7 if the counter is the more urgent need.

---

## Returns

A return is a `RETURN` ledger movement plus a return record citing the original
dispense. Whether returned stock goes back to `AVAILABLE` or to `QUARANTINED` is
a **regulatory and clinic-policy decision**, not a default — many jurisdictions
forbid restocking a dispensed medicine outright. The engine answers it.

Financially, a return produces a credit note through the existing engine. It
never edits the original invoice; that engine's lifecycle guard would refuse
anyway, and correctly.

---

## Controlled substances

The framework, not a country's rules:

- Classification lives in `product_regulatory_profiles` per jurisdiction. A
  product is Schedule X in one country and unscheduled in another.
- Storage: a controlled product's regulatory profile may require a location of
  kind `CONTROLLED_CABINET`. The allocation step checks it.
- Every controlled dispense writes an audit row of its own kind, above and
  beyond the ordinary one.
- Register/reporting obligations are `REPORTING` rules in the pack, surfaced as
  a report in PI-22. **Nothing is filed automatically** — that is a claim about
  a legal obligation and needs a human.

---

## PHI discipline

- The prescription queue and every dispense read write a `data_access_logs` row
  through `recordDataAccess` (PI-ADR-016). One row per request, never per result
  row, using the existing dedupe window.
- `data_access_logs` takes ids, enums, counts and a hash. **Never a medicine
  name, never a patient name.** "Dispensed methadone to patient X" in a
  compliance-readable table is itself a disclosure.
- No PHI in Redis, no PHI in `localStorage`, no patient identifier in a URL
  query parameter.

---

## What pharmacy must never do

|                                                            | Why                             |
| ---------------------------------------------------------- | ------------------------------- |
| Write or amend a prescription                              | Invariant 7                     |
| Compute a tax rate                                         | PI-ADR-006                      |
| Insert an `invoice_item`                                   | PI-ADR-005 / PI-ADR-006         |
| Read a regulatory rule row directly                        | PI-ADR-007                      |
| Write `stock_balances`                                     | PI-ADR-004                      |
| Hold an `is_otc` or `is_controlled` boolean on the product | Both are per-jurisdiction facts |
| Default to permitting anything the engine did not rule on  | PI-ADR-007                      |
