# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-12 · **By:** session PI-2 (Inventory Foundation)

---

## What we are building

A global, extensible **Product + Inventory + Pharmacy + Clinical Consumption +
Procurement + Regulatory platform** for rcln. Not a pharmacy module — shared
infrastructure that clinical, pharmacy, dental, lab, procedural and veterinary
workflows all sit on. Ten target countries via jurisdiction rule packs.

Full orientation: [README.md](README.md).

---

## What has already been completed

**PI-0 — Discovery & Architecture.** Repository audit, seventeen decisions, the
25-phase plan.

**PI-1 — Product Platform Core.** ✅ Merged to `main` (PR #30). Thirteen tables,
the HTTP surface, the screens, and the tests.

**PI-2 — Inventory Foundation.** ✅ This session, on branch
`feat/pi-2-inventory-foundation`. Seven tables, the ledger, the balance cache,
the expiry sweep, five screens and three forms.

---

## What was changed in this session

**Branch:** `feat/pi-2-inventory-foundation`, off `main`. Not pushed.

| Area        | What landed                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Schema      | `packages/db/prisma/schema/inventory.prisma` — 7 models, 6 enums                                                                     |
| Migrations  | `20260815090000_inventory_foundation` + two small ones (see the tracker)                                                             |
| RLS         | 7 tables in **both** the `org_scoped` and `branch_scoped` arrays; 7 RESTRICTIVE `*_visible` policies. `db:rls:check` green at **72** |
| Grants      | `stock_ledger` loses UPDATE/DELETE; `stock_balances` is **SELECT-only** for `rcln_app`                                               |
| Package     | **`@rcln/inventory`** — a NEW package holding the ledger writer and the conversion algebra                                           |
| Permissions | `inventory.location.manage`; granted to BRANCH_ADMIN and PHARMACIST                                                                  |
| Contracts   | `packages/contracts/src/inventory.ts`                                                                                                |
| Services    | `services/inventory/` — movement, location, batch, serial, balance, expiry                                                           |
| Routes      | `/v1/{inventory-locations,batches,serials,stock}`                                                                                    |
| Worker      | The expiry sweep. **The first worker processor that changes clinical state.**                                                        |
| Web         | `/stock` — overview, lots, serials, locations, ledger — plus forms for a location, a lot and a serial. "Stock" nav entry             |
| Tests       | 10 unit + 25 integration + 27 isolation cases. `pnpm validate` green: **1078 API tests across 39 suites**                            |

---

## The three decisions worth knowing before you touch this

### 1. `@rcln/inventory` exists because the worker cannot import the API

PI-ADR-004 says `recordMovement()` is the **only** thing that inserts into
`stock_ledger`. PI-2.8's expiry sweep is a **worker** processor, and the worker
cannot import from `apps/api` — they are two applications, and an app-to-app
dependency would pull express and argon2 into a queue consumer.

So a sweep living in the worker would have had to write its own INSERT, and
"only one writer" would have stopped being true in the same phase that declared
it. The engine moved into a package instead, with `recordAudit` and
`loadUnitGraph` **injected** — the shape `@rcln/billing` already has.

`apps/api/src/services/product/units.ts` is now a **one-line re-export**, so no
existing import changed. It throws `InventoryError` rather than `ValidationError`
now; the API's error middleware maps the three kinds onto exactly the same 400 /
404 / 409, so nothing on the wire moved.

### 2. `EXPIRY`, `DAMAGE` and `RECALL` are MOVES, not `−` removals

This refines the sign table in
[INVENTORY_ARCHITECTURE.md](INVENTORY_ARCHITECTURE.md). Expired stock has not
left the building: it is on the shelf, undispensable, waiting to be destroyed,
and it has to be counted and valued until it is — which the same document's
status model says in the next section. Written as a `−` it would vanish from
every count on the day it expired and leave the clinic unable to say what it is
about to dispose of. **`DISPOSAL` is the `−`.**

### 3. The bucket lock is an ADVISORY lock, and that is forced

`rcln_app` holds no INSERT, UPDATE or DELETE on `stock_balances` — that is
PI-ADR-004 rule 2 made literal. But **Postgres requires the UPDATE privilege to
take a row lock**, so `SELECT ... FOR UPDATE` on that table raises 42501 for the
very role the whole write path runs as. Measured, not reasoned about: the
row-lock version failed _every_ movement.

`pg_advisory_xact_lock` needs no privilege, releases on COMMIT, and serialises
exactly the right writers. Both buckets are locked in **sorted key order in one
statement**, which is what stops two opposite transitions deadlocking.

---

## Current phase / current task / next task

|                   |                                                                    |
| ----------------- | ------------------------------------------------------------------ |
| **Current phase** | PI-2 — COMPLETE. Both reviews run and acted on                     |
| **Current task**  | Click the screens in a browser — the last open item                |
| **Next phase**    | PI-3 — Movements                                                   |
| **Next task**     | **PI-3.1 — adjustments with mandatory reason codes** (mostly done) |

### Before starting PI-3

1. **Both reviewer passes have run.** Two CRITICALs, one HIGH, eleven WARNINGs;
   all fixed bar two accepted. Read the CHANGELOG entry — three of the fixes
   changed the shape of things PI-3 will build on: the branch-composite foreign
   keys, the `actor_is_member` policy, and the sweep's one-transaction-per-bucket
   loop.

   ⚠️ **The two CRITICALs are worth carrying forward as patterns.**
   `REVOKE ... FROM PUBLIC` does not remove a role-specific grant — this
   repository's init script GRANTs EXECUTE on every function to `rcln_app` by
   default, so a SECURITY DEFINER function must name the role. And `apps/web` has
   no test suite, so any pure function that lands there is untested by
   construction: put it in a package instead.

2. **Read `packages/inventory/src/movement.ts` before writing any new movement.**
   PI-3's transfers, PI-4's receipts, PI-7's dispensing and PI-9's consumption
   all go through `recordMovementIn`. Adding a movement type means adding it in
   FOUR places that must agree: the Prisma enum, the `stock_ledger_direction`
   CHECK, the `DIRECTION` table, and `DEFAULT_STATUS`. `inventory-movement.test.ts`
   asserts the first and third agree; nothing catches the CHECK drifting.
3. **PI-3's transfers are the first PAIR.** `TRANSFER_OUT` and `TRANSFER_IN` are
   two ledger rows citing one transfer id, and they must commit together —
   `recordMovementIn` takes a `tx` precisely so a caller can write both inside
   one transaction. That is why `manualMovementType` excludes them from the HTTP
   surface today.

---

## Files that must be inspected before continuing

| File                                                    | Why                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/inventory/src/movement.ts`                    | The only ledger writer. Direction table, bucket locking, tracking-mode checks         |
| `packages/db/prisma/migrations/…_inventory_foundation/` | Every CHECK, both triggers, both REVOKEs, and the RLS block. Read the comments        |
| `packages/db/prisma/rls/enable-rls.sql`                 | The seven tables are in TWO arrays and the visible loop. ⚠️ Mirrored in the migration |
| `apps/api/src/services/inventory/balance.service.ts`    | `verifyBalances()` — the replay. PI-3 must keep it green                              |
| `apps/api/tests/integration/stock-ledger.test.ts`       | The concurrency proofs. PI-3's transfer atomicity test belongs beside them            |
| `apps/worker/src/inventory/expiry.processor.ts`         | The `MovementDeps` binding a worker-side movement needs                               |

---

## Known issues

**1. The worker's `MovementDeps` is a second implementation.** `recordAudit` and
`loadUnitGraph` are written against `@rcln/db` directly in the worker, because it
cannot import the API's. Nothing catches the two drifting; the interface is kept
deliberately tiny — one INSERT and one pair of SELECTs — so that staying in step
is a realistic ask.

**2. Three write surfaces exist on the API with no screen, and each belongs to a
later phase.** Recording a movement is **PI-3.6** (the endpoint and its
permission gate are done); the recall workflow is **PI-10** (`POST
/batches/:id/hold` works); assigning a serial to a patient is **PI-9** (`POST
/serials/:id/assign` works). None is a PI-2 gap.

**2b. The product pickers on the lot and serial forms are capped at 100 rows per
tracking mode** and say so when the cap is hit. A searchable picker over a large
catalogue is PI-23's work, beside the barcode resolver.

**3. Nothing has been clicked in a browser.** Same open item PI-1 left.

**4. `RESERVED` and `IN_TRANSIT` are real statuses with no workflow.** Deliberate
— the enum members exist so PI-3 needs no migration.

**5. Five migrations, not three.** Two more landed from the reviews:
`..093000_inventory_security_review_fixes` (the function REVOKEs, the
`actor_is_member` policy) and `..094000_inventory_branch_composite_keys` (the
three-column foreign keys).

**6. Two migration corrections were made in place, before the branch left this
machine.** `_prisma_migrations.checksum` was updated by hand to match. Do not do
this once a migration has been pushed; the rule against editing an applied
migration exists for migrations that have shipped, and this one had not.

---

## Tests

|                        |                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Currently passing**  | **1087 API tests across 39 suites**; `db:rls:check` green at **72** tables; `pnpm validate` green end to end |
| **Currently failing**  | None.                                                                                                        |
| **Migrations pending** | None. Five applied this session; `prisma migrate status` reports the schema in sync.                         |

⚠️ **The process traps from PI-1 still apply.** Migrations replay in NAME order
and this repository's are hand-dated ahead of the wall clock, so anything Prisma
generates must be re-dated past the highest existing directory. And an applied
migration is checksummed including its comments.

---

## Unresolved questions

**Still open:** OD-3 (localisation), OD-5 (who may set `REGULATORY_REVIEWED` —
**needs the user**, blocks PI-6), OD-6, OD-7, OD-8.

**New, and PI-3 has to answer it:** an inter-branch transfer holds stock in
`IN_TRANSIT` **owned by the sending branch**. The receiving branch cannot see it
under `branch_isolation`, which is correct and also means a receipt at branch B
has to reach a row scoped to branch A. Either the receiving user's context spans
both branches, or the in-transit row is written twice. Decide it before writing
the transfer service, not during.

---

## Do not

- Do not restart PI-0, PI-1 or PI-2.
- Do not add a second writer to `stock_ledger`. If a movement needs a different
  shape, it needs a movement type and a CHECK, not a service that inserts.
- Do not write `stock_balances` from application code. `rcln_app` cannot, and the
  REVOKE is what makes rule 2 a fact rather than an agreement.
- Do not use `SELECT ... FOR UPDATE` on `stock_balances`. It raises 42501 — see
  decision 3 above.
- Do not write `REVOKE ALL ON FUNCTION ... FROM PUBLIC` and believe the function
  is private. Name `rcln_app`, and assert `has_function_privilege` in a test.
- Do not put a pure function in `apps/web`. There is no test suite there, and the
  one that went in shipped rendering `100` as `1`.
- Do not compare an expiry date against `CURRENT_DATE` or a JavaScript `Date`.
  The day is the BRANCH's day, resolved in SQL.
- Do not make inventory platform-extensible, and do not add a `quantity` column
  to `batches`.
- Do not build tax logic. See PI-ADR-006.
