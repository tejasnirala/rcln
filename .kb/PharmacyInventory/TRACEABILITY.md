# Traceability

Traceability owns no tables. It is a set of queries the data model must be able
to answer, and the reason several PI-2 columns exist at all.

**Build it in from the beginning.** Retrofitting traceability means backfilling
references that were never captured, which cannot be done.

---

## The nine questions

| #   | Question                       | Answered by                                                                                   |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | Where did this come from?      | `stock_ledger` where `reference_type = 'GOODS_RECEIPT'` for the batch                         |
| 2   | Which supplier supplied it?    | `batches.supplier_id`, and the GRN → PO → supplier chain                                      |
| 3   | Which receipt introduced it?   | `batches.received_grn_line_id`                                                                |
| 4   | Which batch/lot is it?         | `batches.lot_number`, and `stock_ledger.batch_id` on every movement                           |
| 5   | Where is it now?               | `stock_balances` by `(batch_id, location_id, status)`                                         |
| 6   | Where has it been?             | `stock_ledger` ordered by `occurred_at`, `from_location_id` / `to_location_id`                |
| 7   | Was it dispensed, and to whom? | dispense records via `reference_type = 'DISPENSE'` — **where legally appropriate**, see below |
| 8   | Which procedure consumed it?   | consumption records via `reference_type = 'CONSUMPTION'` → encounter → procedure              |
| 9   | Who did it and when?           | `stock_ledger.actor_user_id`, `.occurred_at`, plus the `audit_logs` row                       |

Every one of them is answered by an **indexed** query. `(organization_id,
reference_type, reference_id)` and `(organization_id, batch_id, occurred_at)`
exist for exactly these.

---

## Two directions

### Backward — "where did this come from"

```text
patient / procedure
      ▲
dispense or consumption record
      ▲
stock_ledger  (DISPENSING / CLINICAL_CONSUMPTION)
      ▲
batch / serial
      ▲
stock_ledger  (PURCHASE_RECEIPT)
      ▲
GRN line → PO line → supplier → manufacturer
```

The question after an adverse event.

### Forward — "where did this go"

```text
recalled batch / serial
      │
stock_ledger, every row for that batch
      │
   ┌──┴───────────────┬──────────────────┐
   ▼                  ▼                  ▼
current balances   dispenses         consumptions
(quarantine        (patients to      (procedures and
 immediately)       contact)          patients)
```

The question during a recall. It must be fast — PI-10 depends on it.

---

## What makes it work

1. **Every movement is a ledger row.** No stock changes hands silently
   (PI-ADR-004).
2. **Every movement carries `reference_type` + `reference_id`.** A movement
   with no reference is untraceable and is refused for every type except a
   manual adjustment, which requires a reason instead.
3. **Serial numbers survive the whole chain.** A serialised implant records its
   serial at receipt, at every transfer, at consumption, and against the
   patient. That is what makes a device recall answerable at patient level.
4. **The ledger is append-only.** A correction is a compensating movement. An
   editable ledger is not a trail.
5. **Regulatory decisions are snapshotted** onto dispensing and consumption
   rows, so "why was this permitted at the time" is answerable years later
   (PI-ADR-008).

---

## Patient linkage and its limits

Question 7 is the one with a legal edge, and the model must let each
jurisdiction answer it differently.

- The **link always exists in the data** — a dispense cites a patient. Without
  it, a recall cannot reach the people who took the product, which is the whole
  purpose of a recall.
- **Who may see it is an access-control question**, and it is `recordDataAccess`
  territory: reading a batch's dispensing list is a PHI read about named people
  and writes a `data_access_logs` row.
- **Whether contacting them is required or permitted is a regulatory question**,
  answered by a `REPORTING_REQUIREMENT` / `TRACEABILITY_REQUIREMENT` rule per
  jurisdiction — not by a hard-coded policy in the recall service.
- Traceability **reports** default to ids and counts. Resolving to names is a
  separate, permissioned, logged action.

---

## What breaks traceability

Each of these has been seen in real systems and each is prohibited here:

| Anti-pattern                                      | Effect                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Mutating a quantity column                        | The movement never existed                                                    |
| A movement with no reference                      | Cannot chain forwards or backwards                                            |
| Deleting a batch when it reaches zero             | The history goes with it — batches are never deleted                          |
| Merging two lots because the numbers matched      | Two manufacturing runs become one, and a recall over-reaches or under-reaches |
| Recording consumption in aggregate at end of day  | Loses the procedure link and the patient link                                 |
| Not capturing a serial "because nobody asked yet" | Unrecoverable; the unit is already in a patient                               |
| Soft-deleting with `isDeleted`                    | Repository rule, and it hides rows from exactly the query that needs them     |
