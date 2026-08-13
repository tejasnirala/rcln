# Changelog

One entry per session. Newest first. Record what changed and why — not what was
discussed.

---

## 2026-08-13 — PI-4 reviews, and the three bugs they found

**Phase:** PI-4 · **Result:** all findings fixed · **Tests:** +1 concurrency case,
+1 migration

Both reviewer passes run on the PI-4 diff. **The tenancy layer came back clean** —
`security-reviewer` found no CRITICAL and no HIGH, enumerated every FK the migration
adds and confirmed all twelve `*_visible` policies are present and RESTRICTIVE, and
verified the `appointment_status_history` trap is genuinely avoided on all four child
tables. It also made a point the phase had not articulated: the org-wide supplier
seam is safe **because** `product_cost_averages` is branch-scoped, so the shared
price book exposes what a supplier QUOTES and never what another branch PAID.

`code-reviewer` found three CRITICALs, all real, and two of them were the same
missing lock.

⚠️ **THE PHASE CLAIMED TO HAVE CLOSED PI-3'S READ-THEN-WRITE RACE AND HAD CLOSED
ONLY HALF OF IT.** `postGoodsReceipt` locks its own `goods_receipts` header — and two
receipts against one purchase order are two DIFFERENT header rows, so nothing
serialised them. The over-receipt tolerance read the PO line unlocked:

    PO for 100, tolerance 0%. Two drafts of 100, posted concurrently.
    Both read received = 0. Both pass assertWithinTolerance. Both increment.
    200 units of real stock against a 100-unit order.

And `purchase_order_lines_quantities_valid` deliberately has NO upper bound, because
the tolerance is a SETTING a CHECK cannot read — so the database did not catch it
either. The same missing lock let a fully-received order regress: receipt B, holding
a stale read, overwrote `RECEIVED` with `PARTIALLY_RECEIVED`, leaving the order on
the "what are we waiting for" screen for ever with nothing outstanding.

Fixed with one `lockPurchaseOrder` before anything reads the order's lines. ⚠️ **The
header and not the lines**, so the acquisition order cannot vary with the order the
lines happen to be in; a receipt cites exactly one order and the sequence is always
receipt-then-order, so no cycle is reachable.

⚠️ **AND THE REGRESSION TEST WAS VERIFIED TO HAVE TEETH BY REMOVING THE LOCK AND
WATCHING IT FAIL.** `serialises two receipts racing against one order line` reports
two fulfilled posts and 200 received without it. The pre-existing
`counts what earlier deliveries already took` passes perfectly well against the
broken version — it only ever exercised the sequential path, which is exactly why the
hole survived the first round of testing.

### The line-order bug, and why the first fix was not one

⚠️ **`created_at` CANNOT ORDER THE LINES OF A DOCUMENT, AND `{ id: 'asc' }` IS NOT A
TIE-BREAK THAT HELPS.** Lines are written by one `createMany`, and
`CURRENT_TIMESTAMP` in Postgres is the TRANSACTION timestamp — so every line gets a
byte-identical `created_at` and the only remaining discriminator is a random uuid v4.

The first attempt at this fix added `{ id: 'asc' }` and the suite went green, which
was a coin flip landing: it makes the order STABLE within a read and still ARBITRARY
relative to what somebody typed. Measured afterwards, the landed-cost apportionment
case failed **two runs in six**. A purchase order printed for a supplier, and a draft
delivery reopened for editing, both listed their lines in a different order each
time.

No money was ever misallocated — `apportionLanded` and `lineData` index consistently
over one array — but the document was unstable. Properly fixed with an explicit
`line_number SmallInt`, unique per document, in
`20260817092000_document_line_numbers`, following `invoice_items.line_number`, which
is the pattern that already existed and should have been matched from the start.

⚠️ **A THIRD MIGRATION RATHER THAN AN EDIT TO THE FIRST**, because
`20260817090000_procurement` had already been applied and Prisma checksums an applied
migration including its comments. Additive is the only safe direction once a
migration has run anywhere.

⚠️ **AND ITS INDEX NAMES ARE PRISMA'S, NOT HAND-CHOSEN.** The first version used
readable names and `migrate diff` reported four permanent `ALTER INDEX` renames as
drift — the same trap `20260814090000_align_fee_schedule_index_name` exists for. The
names were corrected at source and the local checksum repaired, since the migration
had not left the machine.

### Also fixed

- **The rejection half had no CHECK.** `purchase_requisitions_approver_is_not_creator`
  guarded approval; rejection was guarded only by the service, even though its own
  comment argues that self-rejection would put "reviewed and refused" on a document
  nobody reviewed. `purchase_requisitions_rejecter_is_not_creator` added, so the layer
  a later phase cannot forget now covers both halves.
- **`pnpm test:rls` did not work as documented.** The isolation suite's own README
  gives `docker compose exec api pnpm test:rls`, and the script existed only in the
  api workspace — so the documented command failed with
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`. Pre-existing since PI-3 split the suite. Now
  proxied from the root. A gate nobody can invoke as documented is a gate that stops
  being run.

### Corrected, not fixed

⚠️ **"THE APPROVAL SPLIT IS ENFORCED THREE TIMES" GUARDS THE INTERNAL ASK ONLY, AND
THE PREVIOUS CHANGELOG ENTRY AND ROUTE HEADER BOTH OVER-STATED IT.**
`pharmacy.purchase_order.manage` predates the split, so its holder — including
`PHARMACIST` — can raise and issue a purchase order with no requisition and nobody's
second signature, then receive against it, with no second user id anywhere on the
trail. Not widened by PI-4 and deliberately not narrowed, because revoking a code
every existing clinic holds is the one thing a permission change must not do
silently. The wording is corrected in the route header and the gap is now its own
KNOWN_ISSUES row rather than a parenthetical.

### Rejected

One finding was raised by the session and correctly overruled by the reviewer:
`product_cost_averages` has no `@@unique([organizationId, id])`, which looked like a
convention deviation. It matches `StockBalance`, which has none either — both are
leaf tables nothing composite-FKs to, and adding one would have bought a migration
for nothing.

---

## 2026-08-13 — PI-4: procurement, end to end

**Phase:** PI-4 · **Result:** complete · **Tests:** +37 integration, +21 unit,
+15 isolation · **RLS:** 76 → **88** tables

How stock ENTERS the system. Twelve tables, seven screens, two migrations, and the
whole chain from a branch asking for something to the cost of it landing on a shelf:
supplier → price book → requisition → approval → purchase order → delivery →
inspection → return, with a moving average behind all of it.

### The four calls worth knowing

**A supplier is the ORGANIZATION's vendor, not a branch's.** The three supplier
tables are org-wide; all nine document tables are branch-scoped absolutely. A group
negotiates one contract, one price book, one set of tax numbers — branch-scoping
them would mean three rows and no way to answer "what do we spend with them".

⚠️ **The cost is that a branch-scoped storekeeper reads the whole price book, and a
test pins it** — `shows the whole organization's price book to a single-branch
reader`. That width is intended and it looks exactly like a leak in review, so a
later phase "fixing" it would break ordering at every multi-branch clinic. Nothing
branch-confidential may ever be added to those three tables.

**`PURCHASE_RETURN` is a new movement type, and PI-2's schema said it would not be.**
That comment said a purchase return would be a `TRANSFER_OUT` to the supplier. It
cannot be: `TRANSFER_OUT` means "went to another branch of ours" to every report
that reads the column, and the outstanding-quantity arithmetic over
`stock_transfers` reads exactly those rows — a purchase return written as one shows
up as stock in transit between two of the clinic's own sites, on a van that does not
exist. Distinguishable only by `reference_type`, which no aggregate groups by.

It is a REMOVE with **no default `statusFrom`**, the second member after `DISPOSAL`
that refuses to guess. What is going back — sound stock ordered in error, stock
refused at inspection, stock damaged in the box — IS the content of the record.

⚠️ **AND IT COST A SECOND MIGRATION FOR A REASON NOTHING WARNS ABOUT.** Postgres
refuses to USE a new enum value in the transaction that ADDED it, and Prisma runs
each migration inside one — so `ALTER TYPE … ADD VALUE 'PURCHASE_RETURN'` and the
`stock_ledger_direction` CHECK that names it cannot ship together. The SQL parses,
the schema file is consistent, and `prisma validate` is perfectly happy; it only
fails against a database. Split into
`20260817091000_purchase_return_movement_direction`, which is fail-closed in
between: a `PURCHASE_RETURN` row matches none of the old CHECK's shapes and is
refused.

**The approval split is enforced three times and only one layer cannot be forgotten.**
Two permission codes, a service check against `created_by_id`, and
`purchase_requisitions_approver_is_not_creator`. ⚠️ **It guards the internal ASK and
not the money** — see the review entry above; `pharmacy.purchase_order.manage`
predates it and needs no second signature. The first two are each one edit
from absent. A clinic may grant both codes to one person — a single-doctor clinic
has nobody else, and refusing would be a platform deciding how a business is
staffed — and they still cannot self-approve ONE document, because the CHECK
compares two user ids rather than two permissions.

⚠️ Rejection is gated by the same check as approval, which looks like over-reach and
is not: rejecting your own requisition is indistinguishable in effect from
withdrawing it, and allowing it would put "reviewed and refused" on a document
nobody reviewed — the audit trail lying in the direction that looks diligent.

**Costing is a pure module in `@rcln/inventory`, for the reason FEFO ordering is.**
A receipt that posts, writes its legs and lands stock on the right shelf at a unit
cost one paisa out looks entirely correct from every angle a route test can see, and
surfaces a year later as a valuation that does not reconcile.

⚠️ **The running TOTAL is stored and the average is DERIVED.** Storing the average
would round at every receipt and compound;
`does not drift over twenty awkwardly-priced receipts` is the case that pins it.

⚠️ `apportion()` in `@rcln/invoicing` was found by `pnpm kb:find` and deliberately
NOT reused. It refuses `total > totalWeight` because a discount larger than the bill
is a credit note — and freight larger than the goods is an ordinary receipt, a
single vial couriered overnight. It also throws on the integer overflow that a
wholesale-sized delivery reaches, where `apportionByValue` works in `bigint`.

### What the tests caught

**One real bug, and it was in the read path.** `createMany` gives every line the
same `created_at`, so `orderBy: { createdAt: 'asc' }` returned a document's lines in
a NONDETERMINISTIC order on each read — found by the landed-cost apportionment case,
which asserted the shares in line order. All four document services now tie-break on
`id`.

⚠️ **`stock_transfer_lines` in PI-3 has the same `orderBy` and the same latent
issue.** Not changed here, because it is outside this phase's diff and its own
suites do not assert line order. Recorded in KNOWN_ISSUES.

**And two process traps, both already documented and both hit anyway.** Prisma dated
the generated migration BEHIND the highest existing directory (they are hand-dated
ahead of the wall clock), and `pnpm test` now OOMs the api container outright rather
than only `pnpm validate` — the suite was run in five slices instead. Known issue 6
from PI-3, now worse.

⚠️ **The dev database also had a checksum mismatch on an applied migration**
(`20260815092000_inventory_expiry_sweep_function`), unrelated to this phase. Repaired
by re-running that migration — it is `CREATE OR REPLACE` throughout — and correcting
the recorded checksum, rather than `prisma migrate reset`, which would have dropped
the developer's data.

### Not done

**Nothing has been clicked in a browser.** The same open item PI-1, PI-2 and PI-3
each left. Both reviewer passes are also still to run on this diff — PI-3's three
CRITICALs were all read-then-write races, and every service here takes the header's
row lock first for exactly that reason, but that is a claim a reviewer should test
rather than one to take on trust.

---

## 2026-08-12 — PI-3 reviews, and the three bugs they found

**Phase:** PI-3 · **Result:** all findings fixed · **Tests:** +4 regression cases

Both reviewer passes run on the PI-3 diff. **The tenancy layer came back clean** —
the security reviewer tried to break the two-ended transfer policy and could not,
and confirmed the in-transit claim holds: dispatch writes only at
`from_branch_id`, receipt only at `to_branch_id`, cancel only at
`from_branch_id`, and no tenant context is widened anywhere. Every finding was in
the transfer and reservation SERVICES.

⚠️ **Both reviewers independently found the same top bug**, which is the strongest
signal either produced.

### 1. A duplicate `lineId` on receipt minted stock · CRITICAL

`receiveTransfer` built its line map ONCE and read `receivedQuantityBase` off
that object every iteration, and the row write was an absolute assignment rather
than an increment. Two entries naming one line both measured against the same
untouched value, both passed the over-receipt check, both wrote a `TRANSFER_IN`
leg, and the row recorded only the last. **Ten units sent became twenty
received**, the document read fully received with nothing outstanding, and
`stock_transfer_lines_quantities_sane` was satisfied throughout because the ROW
never held more than was sent.

⚠️ **Nothing else would have caught it.** `verifyBalances()` agrees with the
inflated figure — both legs are genuine ledger rows. The web form cannot produce
it, because `receive.<lineId>` FormData keys collapse; the API is the boundary.

Fixed in both layers: a uniqueness `.refine()` on the contract, and per-line
accumulation in the service so the loop no longer depends on a well-formed
request to be correct.

### 2. Every transfer state transition was a read-then-write race · CRITICAL

`withTenant` opens a plain READ COMMITTED transaction and the service read the
status with a plain `findUnique`. Two concurrent dispatches both see `DRAFT` and
both write a full set of legs. The nastiest pair is **cancel against receive**,
because they write at DIFFERENT branches — the compensating leg at the sender and
the real one at the receiver touch different buckets, so the engine's advisory
bucket locks never bring them into contact. Ten dispatched, twenty landed.

Fixed with `lockTransferOrThrow` — `SELECT … FOR UPDATE` on the header before any
leg is written. ⚠️ `FOR UPDATE` is legitimate here and refused on
`stock_balances`, and the difference is the grant: Postgres needs the UPDATE
privilege to take a row lock, `rcln_app` has it on `stock_transfers` and not on
the balance cache.

### 3. The manual release raced the sweep into a double release · CRITICAL

`releaseReservationIn` wrote the movement first and updated unconditionally —
while `reservation-sweep.ts`, one package over, claims with `updateMany({ where:
{ id, status: 'ACTIVE' } })` and **documents in a comment exactly why the other
order is wrong**. The docstring claiming the two were shared was false: the sweep
has its own copy, correct, and this was the copy that was not.

A pharmacist pressing Release as the hourly sweep reached the same reservation
got two `RELEASE` movements for one hold, draining the `RESERVED` bucket on
behalf of some other active reservation. Fixed by claiming first; the dead
`EXPIRED` parameter is gone with it.

### Also fixed

- **A serial fitted to a patient between draft and dispatch was still
  transferable.** `assignSerial` writes no ledger movement and
  `recordMovementIn`'s serial read selects neither the patient link nor the
  status, so a PHI-bearing row could be moved into the receiving branch's RLS
  scope. Re-checked at dispatch and at receipt now; the refusal names the device
  and never the patient.
- **`toLineDetail` read the batch JOIN rather than the line's own snapshot** —
  the same bug the header already had, one level down, so the receiver saw "no
  lot number, no expiry" on the delivery note they were checking against a pack.
- `updateTransfer` set `toLocationId` with no branch check, deferring the
  refusal to dispatch as an unreadable FK error.
- Receipt now sorts lines into a canonical lock order; the client's order could
  deadlock two overlapping receipts.
- `assertReasonCode`'s `findFirst` had no ordering, so a tenant code shadowing a
  later platform code resolved nondeterministically.
- Two `as string` assertions and one float comparison on a counted quantity.

### What the reviewers confirmed clean

RLS coverage on all four tables including the third-branch case for header and
lines; the platform-extensible policy and its immutability trigger; all four
`*_visible` policies; the new SECURITY DEFINER function's grant (it does **not**
repeat PI-2's `REVOKE … FROM PUBLIC` CRITICAL); no PHI in any log, error or job
payload; no raw Prisma, no `$queryRaw` interpolation, no 403-instead-of-404, no
mass assignment; exact decimal arithmetic throughout the allocation path; no
fetch waterfalls in the new screens.

---

## 2026-08-12 — PI-3: Movements

**Phase:** PI-3 COMPLETE · **Result:** shipped on `feat/pi-3-movements` ·
**Tests:** 1155 API across 41 suites passing, 0 failing

### Changed

| Area        | What                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `stock_reason_codes`, `stock_transfers`, `stock_transfer_lines`, `stock_reservations`; `products.allocation_strategy`                  |
| Migrations  | 4: movements · reservation sweep function · location snapshot · lot snapshot                                                           |
| RLS         | 76 tables green. One platform-extensible table, one bespoke two-ended policy, one hand-restated child predicate                        |
| Package     | `@rcln/inventory` + `allocate.ts`, `reservation-sweep.ts`; `toBaseUnits` exported for transfer lines                                   |
| Permissions | `inventory.stock.reserve`, `inventory.reason_code.manage`                                                                              |
| Worker      | Reservation sweep at `:30`; `movementDeps` extracted so two processors share one binding                                               |
| Web         | `/stock/transfers`, `/stock/reservations`, `/stock/adjustments/new`; `TransferProgress` extends the bucket bar rather than rivaling it |

### Decisions

**In-transit stock is held by the DOCUMENT.** A refinement of
INVENTORY_ARCHITECTURE.md's sender-owned `IN_TRANSIT` bucket, forced by
`branch_isolation`: an in-transit bucket at the sender makes the RECEIVER write
against a branch they cannot see, which needs either a widened tenant context or
a second ledger writer. Both legs are single-branch writes instead. The cost —
in-transit quantity is not in `stock_balances` — is recorded for PI-22 and
pinned by a test.

**Reason codes are platform-extensible**, the only table in the inventory domain
that is. A reason code is a WORD, not a fact about a clinic; thirteen ship in the
migration so a clinic can record its first adjustment without inventing a
vocabulary. The ledger still stores the code as a STRING — a row must outlive
what explained it.

**The master governs the manual surface only.** The sweep writes `EXPIRED` and
`setBatchHold` writes `QUARANTINE`; neither goes through `recordMovement`, and
neither belongs in the picker.

### Issues found

Two, both found by tests and both invisible from reading — the query is correct,
the policy is correct, and they are correct about different things:

1. The receiving branch could not read its own delivery note (`inventory_locations`
   is branch-scoped, so the join returned NULL rather than an error). Fixed by
   snapshotting the shelf names onto the transfer.
2. The receiving branch could not create its own lot row, so receipt raised
   `Batch not found` at the moment somebody signed for a delivery. Fixed by
   snapshotting the lot's identity onto the line.

Neither was fixed by weakening a policy. A third, smaller: `planAllocation`
emitted two decimal scales in one plan — invisible on screen because
`readableQuantity` trims both — found by a unit test asserting on one.

### Next

**PI-4 — Procurement.** See [NEXT_SESSION.md](NEXT_SESSION.md).

---

## 2026-08-12 — PI-2 reviews, and the two CRITICALs they found

**Phase:** PI-2 · **Result:** both reviews run and acted on · **Branch:**
`feat/pi-2-inventory-foundation`

`security-reviewer` and `code-reviewer` both ran over the finished diff. Two
CRITICALs, one HIGH, eleven WARNINGs and a page of INFO. Everything except two
accepted items is fixed. `pnpm validate` green at **1087 API tests across 39
suites**; `db:rls:check` green at 72 tables.

### CRITICAL 1 — the REVOKE that revoked nothing

`REVOKE ALL ON FUNCTION stock_balances_apply_delta(...) FROM PUBLIC` **does not
remove the grant `rcln_app` actually holds.** `infra/postgres/init/01-roles-and-
extensions.sql` carries

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rcln_app;
```

so every function a migration creates is granted to the application role at
creation, as a role-specific grant. Revoking from PUBLIC removes a different one.
Measured: `has_function_privilege('rcln_app', …) = true`, and calling it as
`rcln_app` with no tenant context reached the INSERT and failed only on a foreign
key.

That function is SECURITY DEFINER, bypasses RLS on `stock_balances`, and takes
the organization, branch, location, status and delta **as arguments**. So the
request-path role held an arbitrary cross-tenant write into the balance cache —
the one number the append-only ledger exists to make unforgeable — and the
`REVOKE INSERT, UPDATE, DELETE ON stock_balances` was nullified by the very
function it was written to make safe.

Fixed in `20260815093000_inventory_security_review_fixes`, which names
`rcln_app` explicitly for both balance functions. The isolation suite now asserts
`has_function_privilege` is false for each — the table grants were tested and the
function grants were not, which is exactly how this hid.

### CRITICAL 2 — `readable('100')` returned `'1'`

```ts
quantity.replace(/\.?0+$/, ''); // the point is OPTIONAL
```

On an integer the `0+$` ate the trailing zeros of the number itself: `100` → `1`,
`500` → `5`, `-30` → `-3`. Every quantity on every stock screen, an order of
magnitude small, on a screen a pharmacist reconciles against a shelf. A bare
integer is a legitimate wire value — Prisma's `Decimal.toString()` drops the
fractional zeros before the string leaves the server — so it was not theoretical.

It broke no test because `apps/web` **has no test suite**. So the function moved
to `@rcln/contracts` as `readableQuantity`, beside the `decimalString` it is the
display inverse of, where `apps/api`'s unit suite covers it. Six cases.

### The structural fix: branch-composite foreign keys

Every inventory child referenced its parent through `(organization_id,
<parent>_id)`, which proves the lot or shelf belongs to this TENANT and says
nothing about which BRANCH holds it — so a movement at branch A citing a shelf at
branch B was a legal INSERT, refused only by a check in `recordMovementIn`.

`20260815094000_inventory_branch_composite_keys` adds
`@@unique([organizationId, branchId, id])` to locations, batches and serials and
composes ten foreign keys on all three columns. It also makes `verifyBalances()`
airtight: the replay groups without `branch_id`, which was only correct because a
location implied one branch — true of the data, and now true of the schema.

### The expiry sweep had two defects, both silent

- **It never selected `serial_id`,** so a `SERIAL` product's expired stock hit
  "must name a serial number" — and one expired serialised device meant **nothing
  at that branch ever expired**, hourly, for ever, with only a log line.
- **It moved every bucket in ONE transaction.** An advisory lock is held to
  COMMIT, so locks accumulated in expiry order — which is not lock order — and
  could deadlock against a concurrent status transition, rolling back the whole
  branch.

Both fixed by restructuring: `findExpiredBuckets` + `expireBucket`, with the
caller opening **one transaction per bucket** and counting failures instead of
aborting. Partial completion was always safe; splitting the transaction is what
makes it useful.

### The rest

- `stock_ledger.actor_user_id` was the eighth plain FK and had no policy — a
  tenant could name any user uuid and read `users.full_name` back through the
  join `listLedger` performs. New RESTRICTIVE `actor_is_member` policy: a
  MEMBERSHIP test, not an identity test, so a countersigned entry and the sweep's
  owner-attributed movements still work.
- `updateSerial` returned `assignedPatientId` and wrote no `data_access_logs`
  row, and re-pointed `batchId`/`currentLocationId` with none of `createSerial`'s
  checks. Both fixed; the checks are now one shared helper.
- `listBalances` and `listLedger` sorted on non-unique keys, so pagination could
  skip and repeat rows. `id` appended to both.
- Deactivating a location was a read-then-write with nothing serialising it —
  a concurrent movement could commit between the balance check and the update and
  strand stock under an invisible location. `FOR UPDATE` on the location row.
- `majorToMinor` returned null for a typo, so a mistyped cost saved as "no cost
  recorded" with no field error. Returns `NaN` now, so Zod reports the field.
- `recordMovementResponse.quantityBase` was `decimalString`, which refuses the
  sign it always carries.
- Duplication: `toDateColumn` had four copies and `emptyToNull` two. Canonical
  ones in `product/values.ts` and `lib/api.ts`. The three older `toDateColumn`
  copies are in Phase 3 code and are left for a follow-up.

### Two accepted, with reasons

- **`inventory_branches_with_expired_stock` is granted to `rcln_app`** (HIGH).
  The worker connects as that role, so the grant is required; the function is
  read-only and takes no argument that widens it. It is the second of this shape
  — `billing_due_subscriptions` is the first — and the real fix is a worker-only
  database role, which is infrastructure work for PI-24.
- **`listLocations` is unpaginated** (WARNING). Locations are the physical places
  a clinic keeps things, every consumer needs the whole set, and the screen groups
  by branch. Recorded in the service with the threshold at which it stops being
  true.

---

## 2026-08-12 — PI-2, Inventory Foundation

**Phase:** PI-2 · **Result:** complete except both reviews · **Branch:**
`feat/pi-2-inventory-foundation`

Seven tables, the append-only ledger, the trigger-maintained balance cache, the
expiry sweep, and four screens. `db:rls:check` green at 72 protected tables;
`pnpm validate` green at 1078 API tests across 39 suites.

### The ledger writer had to leave `apps/api`

PI-ADR-004 says `recordMovement()` is the only thing that inserts into
`stock_ledger`. The expiry sweep is a **worker** processor, and the worker cannot
import from the API — so a sweep written there would have had to write its own
INSERT, and "only one writer" would have stopped being true in the phase that
declared it.

`@rcln/inventory` now holds the engine and the conversion algebra, with
`recordAudit` and `loadUnitGraph` injected. Same shape as `@rcln/billing`.
`apps/api/src/services/product/units.ts` is a one-line re-export, so no existing
import changed; it throws `InventoryError` now, mapped by the error middleware
onto exactly the 400 / 404 / 409 the old classes produced.

### Two things were measured rather than reasoned about

**`ON CONFLICT DO UPDATE` cannot maintain a balance under a `>= 0` CHECK.**
Postgres evaluates a table's CHECK constraints against the **proposed** row
before the unique index is consulted for a conflict, so
`INSERT ... VALUES (-30) ON CONFLICT DO UPDATE SET quantity = quantity + excluded`
is rejected before the arbiter can redirect it into the row holding 100. Every
decrement failed. Rewritten as UPDATE-then-INSERT with a unique-violation retry.

**`SELECT ... FOR UPDATE` needs the UPDATE privilege, which the whole design
revokes.** `rcln_app` holds no INSERT, UPDATE or DELETE on `stock_balances` —
that is rule 2 made literal — and Postgres requires UPDATE to take a row lock,
so the sufficiency check raised 42501 on every movement. Replaced with
`pg_advisory_xact_lock`, which needs no privilege, releases on COMMIT, and is
taken for both buckets in sorted key order in one statement so two opposite
transitions cannot deadlock.

### One deliberate deviation from the architecture doc

`EXPIRY`, `DAMAGE` and `RECALL` are **MOVES between status buckets, not `−`
removals**. Expired stock has not left the building: it is on the shelf,
undispensable, waiting to be destroyed, and it has to be counted and valued until
it is — which INVENTORY_ARCHITECTURE.md's own status model says two sections
after its sign table. `DISPOSAL` is the `−` that records a physical departure.

### The enforcement, in the database

- `stock_ledger`: no UPDATE or DELETE for `rcln_app`, plus an owner-exempt
  trigger — the same two layers `audit_logs` already has.
- `stock_balances`: **SELECT only**. The cache is maintained by a SECURITY
  DEFINER trigger and by nothing else.
- `stock_ledger_direction` pairs every movement type with its sign AND with which
  status buckets it may name. `_tracking_satisfied` is PI-ADR-014.
  `stock_balances_non_negative` is the last line against a negative shelf.
- Seven RESTRICTIVE `*_visible` policies. `batches.product_id` cannot be a
  composite FK — a clinic legitimately stocks a PLATFORM product — so the policy
  is the entire control on that side. Four isolation cases prove a clinic cannot
  create a batch, serial, movement or balance naming another clinic's product.

### Still open

Neither `code-reviewer` nor `security-reviewer` has run, and the security pass is
mandatory: the diff touches the schema, tenancy, RLS, PHI, permissions and raw
SQL. The screens read and do not write. Nothing has been clicked in a browser.

---

## 2026-08-11 — PI-1 code review, and the bugs it found

**Phase:** PI-1 · **Result:** both reviews complete · **Branch:**
`feat/pi-1-product-platform-core`

`code-reviewer` found two CRITICALs and six WARNINGs. All fixed, with a third
bug found by the regression tests written for the first one.

### The one mistake that produced both CRITICALs

```ts
{ ...(cond ? { OR: a } : {}), effectiveFrom, OR: b }   // ← `OR: a` is GONE
```

An object literal takes the **last** value for a repeated key, and a **spread
counts**. Neither TypeScript nor eslint objects. In both resolvers the predicate
that vanished was the jurisdiction filter — the one deciding correctness:

- `resolveTaxCategory` matched every region in the country.
- `resolveIdentifier` matched a barcode against every country's identifiers.
  National codes legitimately collide across countries; this is a live routed
  endpoint. Wrong-product-from-a-barcode is what it exists to prevent.

Both now use `AND: [...]` to carry two `OR` groups.

### The third bug, found by the test written for the first

`orderBy: [{ regionCode: 'desc' }, …]` with `take: 1`, under a comment asserting
"Postgres sorts NULLs last on DESC by default". **It sorts them first.** So the
country-wide row always won and a regional tax override could be configured, be
visible, and never be returned — precisely what that file's own header warns
about, three lines above the code doing it. Fixed with `nulls: 'last'`.

### The rest

- **`PUT /packagings {"levels": []}` destroyed the base packaging row.** The
  guard was `if (base && …)`, so no level 0 skipped the check rather than failing
  it. Refused twice now: `.min(1)` on the contract, unconditional check in the
  service.
- **`withdrawProduct` set `deletedAt`**, making withdrawn products 404 — the
  opposite of the "history keeps resolving" it promised. Status carries it alone;
  `listProducts` excludes `WITHDRAWN` by default so pickers are unaffected.
- **Unit conversions could contradict the graph transitively.** `BOX→TAB = 90`
  was accepted alongside `BOX→STRIP = 10` and `STRIP→TAB = 10`, and because the
  search is breadth-first the new one-hop edge **won** over the correct two-hop
  path. Writes now check the proposed edge against the existing graph.
- **An inclusive `effectiveTo` expired a day early**, in four places at once —
  `@db.Date` comes back at UTC midnight and was compared against an instant. The
  three copies of `toCalendarDate` and two of `decimalToString` are now one
  `values.ts`, which is why the fix was one edit instead of four.
- **`listCategories` inner-joined the depth CTE**, so a category whose parent is
  invisible under RLS vanished from the tenant's **own** list. `LEFT JOIN` now
  surfaces it at the root — this closes the LOW security finding recorded below.
- `buildUnitGraph` threw on a zero-ratio row, contradicting its own comment that
  one bad row must not break every conversion in the clinic.
- Two write paths opened a second transaction for their read-back; both now read
  inside the transaction they already had.

### Tests

`product-resolvers.test.ts` (14 cases) and `product-values.test.ts` (11) are new.
**PI-1 had no products integration test at all**, which is how three resolver
bugs shipped: the isolation suite tests the database, the unit suite tests pure
arithmetic, and nothing tested the query layer between them. Each new case plants
a decoy and asserts which row comes back — all three bugs returned a plausible
row rather than failing, so only a decoy distinguishes them.

**1016 tests across 37 suites**, `pnpm validate` 23/23, `db:rls:check` 65 tables.

---

## 2026-08-11 — PI-1 security review pass

**Phase:** PI-1 · **Result:** security review PASS, code review NOT RUN ·
**Branch:** `feat/pi-1-product-platform-core`

`security-reviewer` confirmed the tenancy story end to end and raised five
findings — nothing CRITICAL, nothing HIGH. `code-reviewer` terminated on a
session limit and produced nothing; that leg of PI-1.10 is still open.

### Fixed

- **`20260814100000_platform_rows_immutable`.** `tenant_isolation` never
  protected a platform row from `DELETE` — Postgres evaluates no WITH CHECK
  where there is no new row, so the permissive USING clause was the whole test —
  nor from `UPDATE ... SET organization_id = '<mine>'`, which satisfies USING on
  the old row and WITH CHECK on the new one and captures the row away from every
  other tenant. A `BEFORE UPDATE OR DELETE` trigger closes both on all
  **seventeen** platform-extensible tables, so `specialties`, `qualifications`,
  `designations` and `role_designations` are fixed alongside the thirteen
  product tables. Neither hole was reachable through the API — `assertMutable`
  guards every mutating path — so this restores a missing second layer.
- **Isolation cases for `medicine_details`, `composition_ingredients` and
  `product_tax_classifications`.** The first had no test at all; the other two
  appeared only in CHECK-constraint tests, which exercise the constraint and say
  nothing about the policy.
- **The slug comment in `products/actions.ts`.** It claimed server actions are
  "bound to the slug on the server before they reach the browser". They are not:
  `.bind(null, slug)` runs inside a CLIENT component, and a server action is a
  public POST either way. The real control is the API's cross-tenant 404 and RLS
  keyed on the token's org, not the slug. Corrected to describe that, with the
  consequence spelled out — `slug` selects a Host header, never an authorization
  decision.

### Accepted, not fixed

Two LOW findings, recorded in [NEXT_SESSION.md](NEXT_SESSION.md) § Known issues:
two service reads that lean on RLS with no app-level org predicate, and the
residual `parent_visible` gap, which is marginally worse than first assessed —
a category parented under an invisible one vanishes from the tenant's own list.

### Found on the way

`invoices.test.ts` "finds a draft by date" computed today in **UTC** while the
service resolves `?from=/&to=` in the branch's zone. Against an Asia/Kolkata
fixture it failed every night between 18:30 and 24:00 UTC and passed the other
18½ hours, which is how it survived. Invariant 6 broken inside a test. Unrelated
to PI-1 and fixed here because it was red.

`@rcln/web#typecheck` is red and deliberately left alone — untracked
`jest.config.ts` and `tests/`, plus jest devDeps in `package.json` with no
lockfile entry and no install. Predates the branch; regenerating the lockfile is
not PI-1's call. Everything else is green: 989 API tests across 35 suites,
`db:rls:check` at 65 protected tables.

---

## 2026-08-11 — PI-1: Product Platform Core

**Phase:** PI-1 · **Result:** COMPLETE (pending review) · **Branch:**
`feat/pi-1-product-platform-core`

The catalogue: thirteen tables answering "what is this thing?", with nothing in
them that has a quantity, a location or a price.

### What landed

Schema, migration with the hand-written half (20 `NULLS NOT DISTINCT` indexes, 4
partial uniques, 9 CHECKs, 2 triggers, the RLS block), 10 RESTRICTIVE
`*_visible` policies, a new `product` permission module, the exact-rational
conversion engine, contracts, eight services, seven route surfaces, the
structural seed, three screens, and the tests. Detail in
[NEXT_SESSION.md](NEXT_SESSION.md).

### Decisions taken

- **OD-1, OD-2, OD-4 resolved** — see [OPEN_DECISIONS.md](OPEN_DECISIONS.md)
  § Resolved. Platform catalogue with tenant extension; org-scoped; structural
  seed only, no medicine data.
- **Dosage form, route and release type are ENUMS, not lookup tables.** Same
  posture as `ProductType`: adding a member is a migration somebody reviews. A
  table would have needed its own platform/tenant policy and its own visibility
  policy to hold one string.
- **The medicine facet is gated by `pharmacy.medicine.*` while the catalogue is
  gated by `product.definition.*`** (PI-ADR-011), and a product's TAX
  classification is gated by `billing.tax.manage`. Three jobs, three decisions.
- **One form rather than the planned create wizard.** Later steps do not depend
  on earlier answers, and a storekeeper adding forty products wants one screen.

### What went wrong, and what it cost

⚠️ **A RESTRICTIVE policy that cannot exist.** `parent_visible` on
`product_categories` self-referenced its own table. Postgres evaluates policy
expressions with RLS disabled on the tables they REFERENCE — which is what makes
the other ten safe — but a self-reference has no such escape and raises
`infinite recursion detected in policy`. Worse, it did not fail in one place:
`products.category_visible` reads `product_categories`, so the recursion
propagated to **every read of `products`, for every tenant**. Caught by
`tenant-isolation.test.ts`. Removed in `drop_category_parent_visible`.
`specialties` has the identical gap for the identical reason, and the warning was
already written above the `parent_scoped` loop in `enable-rls.sql`.

⚠️ **Two migration-process traps, both hit.** (1) Migrations replay in NAME
order and this repository's recent migrations are hand-dated ahead of the wall
clock, so a Prisma-generated timestamp sorts BEFORE its own dependencies and the
shadow replay fails. (2) An applied migration is checksummed including its
comments, so editing one to add a note demands a full database reset.

⚠️ **Pre-existing schema drift, inherited and fixed.** `invoices` had an index in
the database and in a migration that the schema never declared, so every
`prisma migrate dev` emitted a `DROP INDEX` for it into whoever generated the
next migration — and it was applied once before being caught. Fixed by declaring
it, and by renaming `fee_schedule_entries_scope_key` to Prisma's own name, which
was the other half of the same bug. **The rule: keep the generated index name,
and declare hand-written indexes in the schema.**

### Not done

`/code-review` and `security-reviewer` on the diff — the one remaining leg of
PI-1.10, and mandatory before merge. The screens have not been opened in a
browser.

---

## 2026-08-11 — PI-0: Discovery & Architecture

**Phase:** PI-0 · **Result:** COMPLETE · **Production code changed:** none

### Discovery

Audited the repository directly from source rather than from documentation.
Findings in [CURRENT_STATUS.md](CURRENT_STATUS.md). The consequential ones:

- **Nothing exists.** Zero product, inventory, pharmacy, procurement or
  regulatory tables. This is greenfield.
- **`@rcln/tax` is already global** — `(country, region)` jurisdictions,
  `GST`/`VAT`/`SALES_TAX`, `TaxSplit` for India's halves, effective-dated rules
  with tenant-beats-platform precedence, and a `TaxProviderQuote` seam for US
  sales tax. It needs no change. This removed a large slice of assumed work.
- **`InvoiceSourceType` already has `PHARMACY` and `INVENTORY`.**
- **`invoice_items.item_code` and `.tax_category` are already separate columns**,
  so the brief's "HSN must not be the universal identifier" requirement is
  satisfied upstream.
- **`pharmacy.*` and `inventory.*` permission codes already exist and are
  granted to `PHARMACIST`** — 13 codes, gating nothing, because nothing is built.
- **`specialties` / `qualifications` establish the platform-catalogue-with-
  tenant-extension RLS pattern**, which is exactly the shape the global product
  master needs — including the RESTRICTIVE `*_visible` policy on join tables.
- **`prescriptions` and `encounters`/`procedures` do not exist**, hard-blocking
  the pharmacy-dispensing and clinical-consumption phases. Recorded as KI-1/KI-2.

### Decisions

Seventeen recorded in [ARCHITECTURE.md](ARCHITECTURE.md). Load-bearing:

- **PI-ADR-001** — `products` is the root; medicine is an extension row
- **PI-ADR-002** — the regulatory engine ships **before** dispensing, deviating
  from the brief's suggested order, because dispensing's shape depends on it
- **PI-ADR-003** — the catalogue is a platform master with tenant extension
- **PI-ADR-004** — `stock_ledger` is append-only and is the only quantity truth
- **PI-ADR-005** — consumption never creates an invoice line
- **PI-ADR-006** — this programme writes no tax logic
- **PI-ADR-009** — regulatory maturity is a state, and no agent may set the two
  states that imply legal sign-off

### Planning

- 25 phases (PI-0..PI-24) in [MASTER_PLAN.md](MASTER_PLAN.md), ordered so that
  PI-1..PI-6 are unblocked and can start immediately.
- Task-level tracker for PI-0..PI-5 with a completion gate that is explicitly
  not "the code compiles".
- Eight open decisions, two of which need the user (OD-4 catalogue data source,
  OD-5 who signs off a rule pack).

### Files

Created `.kb/PharmacyInventory/` — 29 documents. Created
`docs/pharmacy-inventory/README.md` as a pointer stub, matching the convention
`docs/README.md` already establishes for every moved document.

**Modified: nothing.** No schema, no package, no app, no migration, no seed.

### Why `.kb/` and not `docs/`

`docs/README.md` states that directory is pointer stubs and says "do not add
content to them". `.kb/` is the KnowledgeBase. `.kb/generate.mjs` only removes
files listed in its own `manifest.json`, so a hand-written directory there is
safe from `pnpm kb`.

### Next

**PI-1.1 — unit of measure & packaging engine.** See
[NEXT_SESSION.md](NEXT_SESSION.md) for the exact starting steps.

---

## Template for the next entry

```markdown
## YYYY-MM-DD — PI-n.m: <what>

**Phase:** · **Result:** · **Tests:** n passing / n failing

### Changed

### Decisions

### Issues found

### Next
```
