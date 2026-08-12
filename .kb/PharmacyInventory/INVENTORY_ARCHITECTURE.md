# Inventory Architecture

One engine for medicines, consumables, devices, implants, reagents, dental
materials and veterinary products. Tables in
[DATABASE_MODEL.md](DATABASE_MODEL.md); this is how it behaves.

---

## The ledger contract

**`stock_ledger` is the only source of quantity truth** (PI-ADR-004).

```
                 recordMovement()          ← the ONLY writer
                        │
                        ▼
                 stock_ledger              append-only, two enforcement layers
                        │  trigger
                        ▼
                 stock_balances            a CACHE. Never authoritative.
```

Rules with no exceptions:

1. Nothing outside `recordMovement()` inserts into `stock_ledger`.
2. Nothing at all writes `stock_balances`. The trigger does.
3. A correction is a **compensating movement with a reason**, never an edit.
4. `stock_balances` disagreeing with a ledger replay is a bug in the trigger,
   and the ledger wins. A `verifyBalances()` routine exists from PI-2 and runs
   in tests and on demand.
5. Quantities are stored in the product's **base unit**. What the user typed is
   also recorded (`quantity_entered` + `unit_id`) so a receipt of "2 boxes"
   still reads as "2 boxes" a year later.

### Sign discipline

The caller never chooses a sign. `movement_type` determines it, and a CHECK
constraint enforces the pairing:

| Movement                                                                                   | Sign                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `PURCHASE_RECEIPT`, `TRANSFER_IN`, `RETURN`                                                | `+` — `status_to` only                                              |
| `DISPENSING`, `CLINICAL_CONSUMPTION`, `TRANSFER_OUT`, `DISPOSAL`                           | `−` — `status_from` only                                            |
| `RESERVATION`, `RELEASE`, `EXPIRY`, `RECALL`, `QUARANTINE`, `QUARANTINE_RELEASE`, `DAMAGE` | zero net; they move quantity between STATUSES, not locations        |
| `ADJUSTMENT`                                                                               | either — and therefore the only one that **requires** a reason code |

A caller that could pass `-5` on a receipt is a caller that will.

⚠️ **`EXPIRY`, `DAMAGE` and `RECALL` MOVED TO THE THIRD ROW IN PI-2, AND THE
CHANGE IS DELIBERATE.** They were originally listed as `−`, and that contradicts
the status model in the very next section: expired stock is "visible, countable
and valued", which it cannot be if the movement removed it. Expired stock has not
left the building — it is on the shelf, undispensable, waiting to be destroyed,
and the clinic has to be able to say what it is about to dispose of. Written as a
`−` it would vanish from every count on the day it expired.

`DISPOSAL` is the `−` that records a physical departure, and it is the one
movement with no default `status_from`: what is being destroyed — expired,
damaged, recalled — is the entire content of the record, and defaulting it to
AVAILABLE would let a mis-click destroy sellable stock and log it as routine.

The pairing is enforced by the `stock_ledger_direction` CHECK constraint, and
mirrored in the `DIRECTION` table in `packages/inventory/src/movement.ts`.

---

## Locations

```
branch → inventory_location → storage_area → storage_bin
```

`LocationKind`: `MAIN_PHARMACY`, `SATELLITE_PHARMACY`, `REFRIGERATOR`,
`FREEZER`, `CONTROLLED_CABINET`, `DEPARTMENT_STORE`, `PROCEDURE_ROOM`,
`LAB_STORE`, `DENTAL_STORE`, `VETERINARY_STORE`, `CENTRAL_WAREHOUSE`,
`CONSIGNMENT`, `DISPOSAL`.

Kind drives UI grouping and regulatory storage checks. **Never authorization.**

A branch has many locations. Assuming one is the mistake that makes fridges,
controlled-drug cabinets and departmental stores unrepresentable, and it is
unrecoverable without a migration.

---

## Status model

Two independent axes, and confusing them is PI-ADR-013:

| Axis                    | Values                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `batches.status`        | `ACTIVE`, `QUARANTINED`, `EXPIRED`, `RECALLED`, `DAMAGED`, `DISPOSED`                           |
| `stock_balances.status` | `AVAILABLE`, `RESERVED`, `QUARANTINED`, `BLOCKED`, `EXPIRED`, `DAMAGED`, `RECALLED`, `DISPOSED` |

Only `AVAILABLE` is allocatable. Everything else is visible, countable and
valued, but not dispensable — which is exactly why quarantine works.

### Transitions

```
AVAILABLE ⇄ RESERVED            allocation / release
AVAILABLE → QUARANTINED         recall, quality hold, suspected counterfeit,
                                regulatory block, manual review
QUARANTINED → AVAILABLE         release, with a reason and an audit row
AVAILABLE → EXPIRED             the expiry sweep, automatic
any → DAMAGED / DISPOSED        terminal, with a reason
```

Every transition is a ledger row. There is no status change without one.

---

## Expiry

- `is_expiry_controlled` is a product property; `expires_on` is a batch fact.
  A CHECK ties them together.
- Thresholds are **settings**, not constants (PI-ADR-015): near-expiry windows
  resolve through USER → DOCTOR → BRANCH → ORGANIZATION → PLATFORM → default,
  so a vaccine fridge and a dental store can differ.
- A worker sweep moves `AVAILABLE` → `EXPIRED` on the expiry date **in the
  branch's timezone**, not UTC and not the container's. This is the first real
  worker processor in the repository; the queues are registered and only stubs
  consume them today.
- Near-expiry produces an alert, never a status change.

---

## FEFO

First-Expiry-First-Out is the **default**, not the law.

```
allocate(product, quantity, location, context)
  → candidate batches: status AVAILABLE, not expired, not recalled,
                       not quarantined, at or below the requested location
  → order by expires_on ASC, then received_at ASC   (FEFO)
  → apply overrides:  product-level (a device may want FIFO)
                      jurisdiction-level (PI-5 may forbid dispensing within
                                          N days of expiry)
                      operator override, which is permitted, logged and reasoned
  → return an allocation plan; the caller commits it in one transaction
```

The allocation plan is returned before it is committed so the dispensing screen
can show which batch it will use and let a pharmacist override with a reason.
An allocation that commits silently is one nobody can question.

---

## Reservations

`RESERVED` is a real status with a real row, not a flag. A reservation carries a
`reference_type`/`reference_id` (a pending dispense, an online order, a
scheduled procedure) and an `expires_at`. A worker releases expired
reservations.

Without this, two pharmacists dispense the last strip.

---

## Transfers

```
branch A / Central Store        branch B / Main Pharmacy
        │ TRANSFER_OUT                    ▲ TRANSFER_IN
        └────────── IN_TRANSIT ───────────┘
```

⚠️ **REFINED IN PI-3, AND THE DIAGRAM ABOVE IS NOW THE SHAPE RATHER THAN THE
MECHANISM.** This document said in-transit stock is held in an `IN_TRANSIT`
STATUS owned by the SENDING branch. It is held by the **transfer DOCUMENT**, and
the change was forced rather than chosen.

`branch_isolation` is RESTRICTIVE on `stock_ledger`, so every row written must
carry a `branch_id` inside the writer's scope. A bucket owned by the sender means
the person RECEIVING at branch B has to write a removal against branch A — a
branch they cannot see and must not be able to. The only ways to allow it are to
widen the receiving user's tenant context, which punches the first hole in the
branch boundary, or to write the row twice, which reintroduces the second ledger
writer PI-ADR-004 forbids.

So:

```
dispatch   TRANSFER_OUT at the sender      · actor scoped to A · one leg
receipt    TRANSFER_IN  at the receiver    · actor scoped to B · one leg
```

Both legs cite the transfer id as `reference_id`, so the pair is one join apart.
Neither side ever writes a row at the other's branch and no context is ever
widened. What is outstanding is `sent − received` over the lines of `DISPATCHED`
transfers — a better answer than a bucket, because it names the document, the
date, the sender and what is missing. "It vanished between branches" is the
single most common real-world inventory complaint, and this is the shape that
answers it.

⚠️ **THE COST, FOR PI-22.** In-transit stock is NOT in `stock_balances`. A
valuation report that sums that table and stops is under-counting by whatever is
on a van; it must add the outstanding lines of `DISPATCHED` transfers.
`verifyBalances()` is unaffected — both legs are ledger rows.

The lot's identity and the shelf NAMES travel on the document, because `batches`
and `inventory_locations` are branch-scoped too and the receiver can read
neither. That is what a paper delivery note has always carried. See the
`transfer_location_snapshot` and `transfer_line_lot_snapshot` migrations, both of
which exist because a test found the failure and reading the code did not.

Intra-branch (location → location) is one atomic pair of rows with no in-transit
state, written in one transaction at dispatch.

---

## Costing

- `batches.unit_cost_base` is set at goods receipt, in integer minor units per
  **base unit**, with a currency. A pack-size change never invalidates history.
- Moving average is maintained per (product, branch) for valuation.
- **The billing price is not the inventory cost**, and neither is derived from
  the other. That separation is what makes
  `procedure revenue − consumable cost = contribution` a real number (PI-22).

---

## Concurrency

The ledger is append-only, so writes do not contend. The contended thing is
_allocation_: two dispensers reading the same available quantity.

The pattern, mirroring the numbering service's approach:

1. Read the allocation plan (no lock).
2. In the committing transaction, `SELECT … FOR UPDATE` the balance rows in the
   plan, re-verify availability, insert ledger rows, commit.
3. Availability failing on re-verify is a normal `409`, not an error.

PI-2.11 must prove this with a parallel-writes test, the way the numbering
service already proves gaplessness with 50 parallel issues.

---

## Recall & quarantine capability

The **columns** land in PI-2; the workflow is PI-10. That ordering is
deliberate: a recall the schema cannot represent is a migration under load, and
recalls arrive without notice.

From PI-2 onward, allocation already excludes `RECALLED` and `QUARANTINED`
stock, so a batch set to either status by hand is immediately un-dispensable
even before the workflow exists.
