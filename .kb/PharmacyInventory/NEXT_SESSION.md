# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-12 · **By:** session PI-3 (Movements)

---

## What we are building

A global, extensible **Product + Inventory + Pharmacy + Clinical Consumption +
Procurement + Regulatory platform** for rcln. Not a pharmacy module — shared
infrastructure that clinical, pharmacy, dental, lab, procedural and veterinary
workflows all sit on. Ten target countries via jurisdiction rule packs.

Full orientation: [README.md](README.md).

---

## What has already been completed

**PI-0** Discovery & architecture. **PI-1** Product platform core (merged, PR #30).
**PI-2** Inventory foundation (merged, PR #31) — the ledger, the balance cache,
the expiry sweep. **PI-3** Movements — this session, on
`feat/pi-3-movements`. Not pushed.

---

## What was changed in this session

| Area        | What landed                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `stock_reason_codes`, `stock_transfers`, `stock_transfer_lines`, `stock_reservations`; `products.allocation_strategy`           |
| Migrations  | 4 — movements · reservation sweep function · location snapshot · lot snapshot                                                   |
| RLS         | `db:rls:check` green at **76**. One platform-extensible table, one bespoke two-ended policy, one hand-restated child predicate  |
| Package     | `@rcln/inventory` gains `allocate.ts` and `reservation-sweep.ts`; `toBaseUnits` is now exported                                 |
| Permissions | `inventory.stock.reserve`, `inventory.reason_code.manage` → BRANCH_ADMIN + PHARMACIST (and the two "everything except" roles)   |
| Routes      | `/v1/stock/{reason-codes,reservations,allocations/plan}`, `/v1/stock-transfers/*`                                               |
| Worker      | The reservation sweep, hourly at `:30`. `movementDeps` extracted to `inventory/deps.ts` so two processors share one binding     |
| Web         | `/stock/transfers` (list, new, detail+receive), `/stock/reservations`, `/stock/adjustments/new`; two new nav tabs               |
| Tests       | 13 unit + 35 integration + 25 isolation cases. **1159 API tests across 41 suites**; typecheck, lint and test all green          |
| Reviews     | `code-reviewer` and `security-reviewer` both run. Three CRITICALs and seven smaller findings — **all fixed**. See the CHANGELOG |

---

## The four decisions worth knowing before you touch this

### 1. In-transit stock is held by the DOCUMENT, not by a bucket

```
branch A                                        branch B
  AVAILABLE ──TRANSFER_OUT──▶ (the document) ──TRANSFER_IN──▶ AVAILABLE
             actor scoped to A                actor scoped to B
```

INVENTORY_ARCHITECTURE.md described an `IN_TRANSIT` bucket owned by the SENDING
branch. That makes the RECEIVER write a removal against a branch
`stock_ledger.branch_isolation` hides from them — fixable only by widening their
tenant context, which is the first hole in the branch boundary, or by writing the
row twice, which is the second ledger writer PI-ADR-004 forbids.

So each leg is a single-branch write and no context is ever widened. Outstanding
quantity is `sent − received` over `DISPATCHED` lines.

⚠️ **THE COST, WRITTEN DOWN SO PI-22 DOES NOT REDISCOVER IT.** In-transit stock
is NOT in `stock_balances`. A valuation report that sums that table and stops is
under-counting by whatever is on a van. `verifyBalances()` is unaffected — both
legs are ledger rows — and an integration test pins the property.

### 2. The lot's identity and the shelf names TRAVEL ON THE DOCUMENT

Two migrations exist purely because of this, and both were written after a test
failed rather than after anybody read the code:

- `inventory_locations` is branch-scoped, so the receiver's join to the sending
  shelf returned **NULL, not an error**, and the detail response threw.
- `batches` is branch-scoped, so the receiver could not read the source lot and
  receipt raised `Batch not found` while somebody held the boxes.

Both are fixed by SNAPSHOTS — the shelf names on the transfer, the lot's number,
dates, manufacturer and cost on the line. Neither was fixed by weakening a
policy, and neither is visible from reading: the query is correct, the policy is
correct, and they are correct about different things.

⚠️ **THIS IS THE FAILURE MODE OF THIS WHOLE DOMAIN.** Anything a receiving branch
needs to know about a sending branch's data must be on the document. PI-4's goods
receipts and PI-7's dispensing will hit it again.

### 3. Reason codes are the one platform-extensible table in the inventory domain

PI-ADR-003 says a location, a lot and a movement are facts about one clinic and
never platform data. A reason code is a **word** — "damaged", "counted short" —
and every clinic needs the same dozen on the day it opens. Thirteen ship in the
migration. A clinic adds its own and cannot touch the platform's.

⚠️ The ledger still stores the code as a **string**, not a foreign key, for the
same reason `reference_id` is not one: a row must outlive what explained it.

⚠️ **The master governs the MANUAL surface only.** The sweep writes `EXPIRED` and
`setBatchHold` writes `QUARANTINE`; neither goes through `recordMovement`, and
neither belongs in the picker — "expired" is not an explanation a person chooses
for an adjustment.

### 4. FEFO ordering is a PURE function in the package, on purpose

An ordering rule is wrong in a way no integration test notices: a tie broken the
wrong way dispenses the second-oldest lot, which looks entirely normal until an
audit asks why the oldest expired on the shelf. `packages/inventory/src/allocate.ts`
is testable against every tie, every null and every shortfall — and the unit
suite immediately found a scale inconsistency that was invisible on screen.

⚠️ A lot with **no expiry sorts LAST** under FEFO. Postgres and the naive
comparator both put NULL first, which empties the non-expiring stock while the
expiring stock expires.

⚠️ **PI-5's rule packs NARROW the candidate list, they never reorder it.** A
jurisdiction forbidding dispensing within N days of expiry removes candidates
before the ordering runs. Reordering would override a decision a clinic made on
purpose, which is what the nullable `allocation_strategy` exists to keep visible.

---

## Current phase / current task / next task

|                   |                                                     |
| ----------------- | --------------------------------------------------- |
| **Current phase** | PI-3 — COMPLETE. Both reviews run and acted on      |
| **Current task**  | Click the screens in a browser — the last open item |
| **Next phase**    | PI-4 — Procurement                                  |
| **Next task**     | **PI-4.1 — `suppliers` + supplier tax identifiers** |

### Before starting PI-4

1. **Both reviewer passes have run.** Three CRITICALs and seven smaller
   findings, all fixed — read the CHANGELOG entry, because **all three CRITICALs
   were the same class of mistake and PI-4 can make every one of them again**:

   ⚠️ **READ-THEN-WRITE WITHOUT A LOCK.** `withTenant` is plain READ COMMITTED.
   Reading a status, deciding, then writing is a race in every one of these
   services. Transfers now take `SELECT … FOR UPDATE` on the header first
   (`lockTransferOrThrow`); reservations claim with a conditional `updateMany`.
   A goods receipt has exactly the same shape.

   ⚠️ **A LOOP THAT READS ITS BOUNDS FROM A SNAPSHOT LOADED ONCE.** The receipt
   loop measured every entry against the same untouched `received` value, so a
   duplicate line minted stock — and `verifyBalances()` agreed, because both
   legs were genuine ledger rows. Accumulate within the request, and refuse the
   duplicate at the contract too.

   ⚠️ **A FACT VALIDATED AT DRAFT TIME AND NOT AGAIN AT COMMIT TIME.** A serial
   fitted to a patient between drafting and dispatch was still transferable,
   because `assignSerial` writes no ledger movement and nothing downstream
   re-reads the patient link. Anything a document asserts about the world has to
   be re-asserted when it acts.

2. **Read `packages/inventory/src/movement.ts`, then `transfer.service.ts`.**
   PI-4's goods receipts write `PURCHASE_RECEIPT` through the same engine, and
   the transfer service is the worked example of writing a DOCUMENT whose legs go
   through it. Adding a movement type still means four places that must agree:
   the Prisma enum, the `stock_ledger_direction` CHECK, the `DIRECTION` table and
   `DEFAULT_STATUS`.

3. **A goods receipt will need the snapshot lesson.** A supplier's lot arrives at
   one branch; anything another part of the system needs to know about it that
   lives on a branch-scoped row has to be copied onto the document. See decision 2.

---

## Files that must be inspected before continuing

| File                                                          | Why                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/inventory/src/movement.ts`                          | Still the only ledger writer. `toBaseUnits` is now exported for documents |
| `apps/api/src/services/inventory/transfer.service.ts`         | The worked example of a document whose legs go through the engine         |
| `packages/db/prisma/migrations/…_transfer_line_lot_snapshot/` | Why branch-scoped data has to travel on the document                      |
| `packages/db/prisma/rls/enable-rls.sql`                       | The bespoke `from OR to` policy and the hand-restated child predicate     |
| `apps/api/tests/integration/stock-movements.test.ts`          | PI-4's receipt tests belong beside these                                  |
| `packages/inventory/src/allocate.ts`                          | PI-5 narrows the candidate list here, before the ordering                 |

---

## Known issues

**1. Nothing has been clicked in a browser.** Same item PI-1 and PI-2 left, and
now the only one.

**2. In-transit stock is not in `stock_balances`.** Deliberate; PI-22's valuation
must add the outstanding lines of `DISPATCHED` transfers. See decision 1.

**3. Serial-tracked stock crossing a branch needs a receiver scoped to BOTH
branches**, and is refused with a sentence otherwise. A serial IS the device, so
receipt MOVES the record rather than copying it, and that record belongs to the
sending branch until it does. The one cross-branch write in the flow.

**4. `CONSUMED` is a reservation state nothing can reach yet.** Deliberate: PI-7
and PI-9 move quantity out of `RESERVED` directly and will set it in the same
transaction. The enum member exists so neither phase needs a migration.

**5. The product pickers are still capped at 100 rows.** PI-23's work, beside the
barcode resolver. Unchanged from PI-2.

**6. `pnpm validate` OOMs the api container at its 3 GB limit** when turbo runs
tasks in parallel. `pnpm exec turbo run typecheck|lint|test --concurrency=1` all
pass. Worth raising the limit or pinning the concurrency in `turbo.json`.

**7. The worker's `MovementDeps` is still a second implementation** of the API's.
Now extracted to `apps/worker/src/inventory/deps.ts`, so it is one copy per
application rather than one per processor — but nothing catches the two drifting.
Unchanged in kind from PI-2.

---

## Tests

|                        |                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Currently passing**  | **1155 API tests across 41 suites**; `db:rls:check` green at **76** tables; typecheck and lint green |
| **Currently failing**  | None.                                                                                                |
| **Migrations pending** | None. Four applied this session; `prisma migrate status` reports the schema in sync.                 |

⚠️ **The process traps from PI-1 and PI-2 still apply.** Migrations replay in
NAME order and this repository's are hand-dated ahead of the wall clock, so
anything Prisma generates must be re-dated past the highest existing directory.
An applied migration is checksummed including its comments.

⚠️ **`prisma migrate diff` changed its flags.** `--from-schema-datasource` was
removed; use `--from-config-datasource --to-schema ./prisma/schema --script`.

---

## Unresolved questions

**Resolved this session:** the in-transit question PI-2 raised. See decision 1.

**Still open:** OD-3 (localisation), OD-5 (who may set `REGULATORY_REVIEWED` —
**needs the user**, blocks PI-6), OD-6, OD-7, OD-8.

---

## Do not

- Do not restart PI-0, PI-1, PI-2 or PI-3.
- Do not add a second writer to `stock_ledger`. A document's legs go through
  `recordMovementIn`; the document table holds paperwork, never quantity.
- Do not write `stock_balances` from application code.
- Do not use `SELECT ... FOR UPDATE` on `stock_balances`. It raises 42501.
- Do not solve a cross-branch read by weakening an RLS policy. Snapshot the fact
  onto the document — see decision 2, which is two migrations' worth of evidence.
- Do not put a pure function in `apps/web`. There is no test suite there.
- Do not compare an expiry date against `CURRENT_DATE` or a JavaScript `Date`.
- Do not add a reason code the SYSTEM writes to the reason-code master; it would
  appear in the adjustment picker.
- Do not build tax logic. See PI-ADR-006.
