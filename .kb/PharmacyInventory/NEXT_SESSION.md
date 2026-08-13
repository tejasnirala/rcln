# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-13 · **By:** session PI-4 (Procurement)

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
**PI-2** Inventory foundation (merged, PR #31) — the ledger, the balance cache, the
expiry sweep. **PI-3** Movements (merged, PR #32) — adjustments, transfers,
reservations, FEFO. **PI-4** Procurement — this session, on
`feat/pi-4-procurement`. Not pushed. **Both reviewers have run and every finding is
fixed** — three CRITICALs, one MEDIUM corrected in the docs, three LOWs.

---

## What was changed in this session

| Area        | What landed                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | 12 tables: `suppliers`, `supplier_tax_identifiers`, `supplier_products`, `purchase_requisitions`/`_lines`, `purchase_orders`/`_lines`, `goods_receipts`/`_lines`, `purchase_returns`/`_lines`, `product_cost_averages` |
| Enums       | `StockMovementType.PURCHASE_RETURN`; five `NumberSequenceType` members (`DISPENSE` unused, on purpose); six new procurement enums                                                                                      |
| Migrations  | 3 — the phase, the ledger CHECK (**the split is not optional; see decision 2**), and `line_number` + the rejection CHECK from the review                                                                               |
| RLS         | `db:rls:check` green at **88** (was 76). Two tenancy classes, seam is BRANCH not platform                                                                                                                              |
| Package     | `@rcln/inventory` gains `costing.ts` — apportionment and the moving average, as pure functions                                                                                                                         |
| Permissions | `procurement.requisition.create` / `.approve` → BRANCH_ADMIN (both), PHARMACIST (create only)                                                                                                                          |
| Settings    | `procurement.over_receipt_tolerance_percent` (0), `procurement.quality_hold_required` (false)                                                                                                                          |
| Routes      | `/v1/procurement/{suppliers,supplier-products,requisitions,purchase-orders,goods-receipts,returns,cost-averages}`                                                                                                      |
| Web         | Seven tabs under `/procurement` — suppliers, price book, requisitions, orders, deliveries, returns, costs. New "Buying" top-level tab                                                                                  |
| Tests       | 21 unit + 38 integration + 15 isolation. **Isolation suite at 294 across 14 files**; typecheck, lint and every suite green                                                                                             |
| Reviews     | **BOTH RUN, all findings fixed.** Security: no CRITICAL, no HIGH. Quality: 3 CRITICALs — two were one missing lock, one was line ordering. See the CHANGELOG                                                           |

---

## The four decisions worth knowing before you touch this

### 1. A supplier is the ORGANIZATION's vendor, and that width is TESTED

```
suppliers · supplier_tax_identifiers · supplier_products    ORG-WIDE, no branch_id
every document table                                        BRANCH-SCOPED, absolute
```

A group negotiates one contract with one distributor. Branch-scoping the supplier
tables would mean three rows, three price lists and no way to answer "what do we
spend with them".

⚠️ **THE COST IS THAT A SINGLE-BRANCH STOREKEEPER READS THE WHOLE PRICE BOOK, AND A
TEST PINS IT ON PURPOSE.** `shows the whole organization's price book to a
single-branch reader` in `tenant-isolation/procurement.test.ts` exists because that
width looks exactly like a leak in review — and adding a branch predicate to those
three tables would break ordering at every multi-branch clinic while looking like a
security improvement. Nothing branch-confidential may ever be added to them; payment
terms and a price per pack are the ceiling.

### 2. A NEW ENUM VALUE AND A CHECK THAT NAMES IT CANNOT SHIP IN ONE MIGRATION

⚠️ Postgres refuses to USE a new enum value in the transaction that ADDED it, and
Prisma runs each migration inside one. So `ALTER TYPE "StockMovementType" ADD VALUE
'PURCHASE_RETURN'` is in `20260817090000_procurement` and the
`stock_ledger_direction` CHECK that names it is in
`20260817091000_purchase_return_movement_direction`.

**The failure is invisible until it is run against a database.** The SQL parses, the
schema file is consistent, and `prisma validate` is happy. PI-5 adds enum members
too; if any CHECK, trigger or default names one, it needs the same split.

⚠️ `PURCHASE_RETURN` IS NOT A `TRANSFER_OUT`, WHICH IS WHAT PI-2'S SCHEMA COMMENT
SAID IT WOULD BE. `TRANSFER_OUT` means "went to another branch of ours" to every
report, and the outstanding-transfer arithmetic reads exactly those rows. It is a
REMOVE with **no default `statusFrom`** — the second member after `DISPOSAL` that
refuses to guess, because what is leaving IS the content of the record.

### 3. The approval split has three layers and only one cannot be forgotten

```
storekeeper                       branch administrator
REQUISITION_CREATE  ──submit──▶   REQUISITION_APPROVE  ──▶ purchase order
```

Two permission codes; a service check against `created_by_id`; and
`purchase_requisitions_approver_is_not_creator`. The first two are each one edit
from absent.

⚠️ **A CLINIC MAY HOLD BOTH CODES AND STILL CANNOT SELF-APPROVE ONE DOCUMENT**,
because the CHECK compares two USER IDS rather than two permissions. `ORG_OWNER`
holds both — it is an "everything except" role — and that is fine for exactly this
reason. A single-doctor clinic has nobody else, and refusing to let them buy anything
would be a platform deciding how a business is staffed.

⚠️ Only an **APPROVED** requisition may become an order. Without that check the whole
split is decoration: a buyer could cite a draft nobody looked at and the order would
carry a link that makes it look authorised.

### 4. Costing stores the TOTAL and derives the average

⚠️ `product_cost_averages.valued_quantity_base` IS THE DENOMINATOR OF AN AVERAGE AND
IS **NOT** STOCK ON HAND. `stock_balances` is what the branch holds; the two diverge
the moment anything is dispensed, expired or transferred. A report that sums that
column as stock is wrong, and it is the most misreadable row in the programme.

Storing the average instead of the total would round at every receipt and compound —
`does not drift over twenty awkwardly-priced receipts` pins it. The value rolled in
is goods **plus landed cost** and never **tax**: input tax is a liability the clinic
may reclaim, not a cost of the goods.

⚠️ **KEYED BY CURRENCY, so one product can have two averages at one branch.** That
is the honest answer when a clinic bought in two; this programme applies no FX policy
anywhere, and PI-22's valuation must sum per currency and say so.

---

## Current phase / current task / next task

|                   |                                                            |
| ----------------- | ---------------------------------------------------------- |
| **Current phase** | PI-4 — code complete, all suites green                     |
| **Current task**  | **Run both reviewer passes.** Nothing else in PI-4 is open |
| **Next phase**    | PI-5 — Global Regulatory Framework                         |
| **Next task**     | **PI-5.1 — `jurisdictions`, `regulatory_authorities`**     |

### Before starting PI-5

1. ⚠️ **THE LESSON OF THIS PHASE'S REVIEW, BECAUSE PI-5 WILL BE ABLE TO REPEAT IT.**
   PI-4 claimed to have closed PI-3's read-then-write race and had closed only HALF of
   it: every service locked its OWN header, and two goods receipts against one
   purchase order are two DIFFERENT header rows. **Locking the document you are
   editing is not the same as locking the document you are DECIDING against.**
   Anything PI-5 writes that reads a shared row and then writes — a rule pack's
   maturity, a decision snapshot's version — needs the same question asked.

   ⚠️ And the test that was supposed to cover it did not: `counts what earlier
deliveries already took` exercises only the SEQUENTIAL path and passes against the
   broken version. `serialises two receipts racing against one order line` was
   verified by removing the lock and watching it fail. **A concurrency test that has
   not been seen to fail is not a concurrency test.**

2. ⚠️ **`created_at` CANNOT ORDER THE LINES OF A DOCUMENT, AND A `{ id: 'asc' }`
   TIE-BREAK IS NOT A FIX.** `CURRENT_TIMESTAMP` is the TRANSACTION timestamp, so one
   `createMany` gives every line a byte-identical value and a random uuid v4 is the
   only discriminator left. The tie-break makes the order stable-per-read and still
   arbitrary; measured, the landed-cost case failed two runs in six against it. The
   fix is an explicit `line_number`, as `invoice_items` already had.

   ⚠️ `stock_transfer_lines` in PI-3 still has the original bug — KNOWN_ISSUES defect
   1, and it needs a migration rather than the one-liner previously recorded.

3. **`pnpm test` now OOMs the api container**, not just `pnpm validate`. The suite
   was run in five slices by path. KNOWN_ISSUES defect 2 — worth fixing before PI-5
   adds more, because a crash masks real failures.

4. **Read `packages/inventory/src/costing.ts` before writing any money arithmetic.**
   `pnpm kb:find` found `apportion()` in `@rcln/invoicing` and it was deliberately
   not reused; the reasoning is in that file's header and it is the pattern to follow
   when the next near-duplicate turns up.

---

## Files that must be inspected before continuing

| File                                                              | Why                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/inventory/src/movement.ts`                              | Still the only ledger writer. `DIRECTION` now has 16 members            |
| `apps/api/src/services/procurement/goods-receipt.service.ts`      | The worked example of a document that creates lots, serials and cost    |
| `packages/inventory/src/costing.ts`                               | Every money calculation in the phase, and why it is not in `apps/api`   |
| `apps/api/src/services/procurement/shared.ts`                     | `resolveReceivingPolicy` — the RLS-exempt settings read, with the pairs |
| `packages/db/prisma/migrations/20260817091000_…_direction/`       | Why a new enum value needs its own migration                            |
| `apps/api/tests/integration/tenant-isolation/procurement.test.ts` | The org-wide/branch seam, and the width that is pinned deliberately     |

---

## Known issues

**1. Nothing has been clicked in a browser.** The same item PI-1, PI-2 and PI-3 each
left, now across seven more screens.

**2. `stock_transfer_lines` renders in a nondeterministic order.** KNOWN_ISSUES
defect 1 — PI-3's copy of the bug PI-4 fixed. Needs a `line_number` migration, not a
one-liner.

**3. A purchase order needs no second signature.** The requisition split guards the
internal ask; `pharmacy.purchase_order.manage` predates it. Found by the security
review, documented rather than narrowed — revoking a held code is silent breakage.

**4. `pnpm test` OOMs the api container.** KNOWN_ISSUES defect 2.

**5. Three permission codes are under the `pharmacy.*` prefix and should not be.**
`pharmacy.supplier.manage`, `pharmacy.purchase_order.read`/`.manage` predate
PI-ADR-001's reasoning. Not renamed, because a rename silently revokes a grant from
every clinic that holds it. The route path is neutral. KNOWN_ISSUES.

**6. Reads on `/v1/procurement/suppliers` sit behind `supplier.manage`.** There is no
`supplier.read` code, and inventing one now would empty every supplier picker until
each clinic re-granted it. KNOWN_ISSUES.

**7. A pharmacist can commit money with no requisition**, via
`pharmacy.purchase_order.manage`. Not widened by PI-4 and not silently narrowed.

**8. In-transit stock is still not in `stock_balances`** (PI-3 decision 1), and now
neither is anything on a purchase order. PI-22's valuation must add both.

**9. The product pickers are still capped at 100 rows.** PI-23's work, unchanged
since PI-2 — now on seven more forms, each of which says so on screen.

**10. `CONSUMED` is still a reservation state nothing can reach.** Unchanged; PI-7
and PI-9.

**11. The worker's `MovementDeps` is still a second implementation** of the API's.
Unchanged in kind from PI-2.

---

## Tests

|                        |                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently passing**  | 176 unit · 38 procurement integration · **294 isolation across 14 files** · every other integration slice green. Typecheck and lint green across 25 packages; `db:rls:check` green at **88** |
| **Currently failing**  | None.                                                                                                                                                                                        |
| **Migrations pending** | None. Two applied this session; `prisma migrate status` reports the schema in sync                                                                                                           |

⚠️ **THE SUITE CANNOT BE RUN IN ONE GO ANY MORE.** `pnpm test` OOMs the api
container. Run it by path, in slices — unit, tenant-isolation, then the integration
files in groups of roughly nine.

⚠️ **The process traps from PI-1, PI-2 and PI-3 all still apply, and PI-4 hit two of
them.** Migrations replay in NAME order and this repository's are hand-dated ahead of
the wall clock, so anything Prisma generates must be re-dated past the highest
existing directory — it generated `20260812170334` against a tree ending at
`20260816093000`. An applied migration is checksummed including its comments.

⚠️ **`prisma migrate diff` changed its flags.** `--from-schema-datasource` was
removed; use `--from-config-datasource --to-schema ./prisma/schema --script`.

⚠️ **A CHECKSUM MISMATCH ON AN APPLIED MIGRATION DOES NOT NEED A RESET.** This
session found one on `20260815092000_inventory_expiry_sweep_function`, unrelated to
PI-4, and `migrate dev` wanted to drop the whole database. It was repaired by
re-running that migration — `CREATE OR REPLACE` throughout, so idempotent — and
correcting the recorded checksum in `_prisma_migrations`. Check whether the file is
idempotent before doing that; a reset destroys the developer's data.

---

## Unresolved questions

**Resolved this session:** none that were open. PI-4 raised and answered its own
tenancy question (decision 1) and its own movement-type question (decision 2).

**Still open:** OD-3 (localisation), OD-5 (who may set `REGULATORY_REVIEWED` —
**needs the user**, blocks PI-6), OD-6, OD-7, OD-8.

⚠️ **OD-5 BLOCKS PI-6 AND PI-5 IS NEXT.** It is worth asking now rather than
discovering it mid-phase.

---

## Do not

- Do not restart PI-0 through PI-4.
- Do not add a second writer to `stock_ledger`. A goods receipt, a return, a
  transfer and the sweep all go through `recordMovementIn`; the document tables hold
  paperwork, never quantity.
- Do not write `stock_balances` from application code.
- Do not use `SELECT ... FOR UPDATE` on `stock_balances`. It raises 42501.
- Do not add a branch predicate to `suppliers`, `supplier_tax_identifiers` or
  `supplier_products`. See decision 1 — a test pins the width and the reason.
- Do not read `product_cost_averages.valued_quantity_base` as stock on hand.
- Do not put a new enum value and a CHECK that names it in one migration.
- Do not order a document's lines by `created_at`, with or without an `id` tie-break.
  Use `line_number`.
- Do not assume locking the row you are EDITING serialises a decision read off a
  DIFFERENT row. See "Before starting PI-5".
- Do not hand-name an index in a migration. Use the name Prisma would generate, or
  `migrate diff` reports permanent drift.
- Do not rename `pharmacy.supplier.*` or `pharmacy.purchase_order.*` without a
  permission-migration mechanism. It silently revokes access.
- Do not solve a cross-branch read by weakening an RLS policy. Snapshot the fact onto
  the document.
- Do not put a pure function in `apps/web`. There is no test suite there.
- Do not compare an expiry date against `CURRENT_DATE` or a JavaScript `Date`. The
  receipt path compares in the BRANCH's zone, in SQL.
- Do not compute tax on a purchase. It is recorded (PI-ADR-006).
- Do not add a reason code the SYSTEM writes to the reason-code master.
