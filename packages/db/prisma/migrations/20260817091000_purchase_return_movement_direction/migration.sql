-- ===========================================================================
-- `PURCHASE_RETURN` joins the ledger's REMOVES group (PI-4.7).
--
-- ── WHY THIS IS A SECOND MIGRATION AND NOT THREE LINES IN THE LAST ONE ──────
--
-- ⚠️ POSTGRES REFUSES TO **USE** A NEW ENUM VALUE IN THE TRANSACTION THAT ADDED
--   IT. `20260817090000_procurement` runs `ALTER TYPE "StockMovementType" ADD
--   VALUE 'PURCHASE_RETURN'`, and Prisma runs each migration inside one
--   transaction, so naming the value in a CHECK constraint there fails with
--   `unsafe use of new value of enum type StockMovementType`. Not a warning — the
--   whole migration aborts.
--
--   The failure is also invisible until it is run: the SQL parses, the value
--   exists in the schema file, and `prisma validate` is perfectly happy. It only
--   goes wrong against a database.
--
-- ⚠️ AND UNTIL THIS MIGRATION RUNS THE SYSTEM IS FAIL-CLOSED, WHICH IS WHY
--   SPLITTING IT IS SAFE. A `PURCHASE_RETURN` row inserted between the two
--   migrations matches none of the existing CHECK's four shapes and is refused.
--   The two migrations therefore cannot leave a window in which an unsigned
--   movement commits — only one in which a correct one is refused, and nothing
--   writes that movement type until PI-4's return service exists anyway.
--
-- ── WHY A NEW MEMBER RATHER THAN `TRANSFER_OUT` ─────────────────────────────
-- `RETURN`'s comment in PI-2 said a purchase return would be a `TRANSFER_OUT` to
-- the supplier. It cannot be. `TRANSFER_OUT` means "went to another branch of
-- ours" to every report that reads the column, and the outstanding-quantity
-- arithmetic over `stock_transfers` reads exactly those rows: a purchase return
-- written as one shows up as stock in transit between two of the clinic's own
-- sites, on a van that does not exist. `reference_type` distinguishes them and no
-- aggregate groups by it. See the enum comment in inventory.prisma.
--
-- ── FOUR PLACES MUST AGREE, AND THIS IS TWO OF THEM ────────────────────────
--   1. the Prisma enum                        inventory.prisma            ✔
--   2. THIS CHECK                             here                        ✔
--   3. `DIRECTION`                            packages/inventory/src/movement.ts
--   4. `DEFAULT_STATUS`                       the same file — and PURCHASE_RETURN
--      deliberately gets NO entry there, for the reason DISPOSAL has none.
--
-- `apps/api/tests/unit/inventory-movement.test.ts` asserts every member of the
-- enum appears in `DIRECTION`, which is what catches 3 being forgotten. Nothing
-- catches 2, which is why it is written out here at length.
-- ===========================================================================

ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_direction";

ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_direction" CHECK (
    (
      "movement_type" IN ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'RETURN')
      AND "quantity_base" > 0
      AND "status_from" IS NULL
      AND "status_to" IS NOT NULL
    ) OR (
      -- ⚠️ `PURCHASE_RETURN` IS ADDED HERE AND NOWHERE ELSE IN THIS CONSTRAINT.
      --   Stock going back to a supplier has physically left the building, so it
      --   is a `−` exactly as `DISPOSAL` is — not a MOVE. Writing it as a move
      --   would leave the quantity sitting in some bucket of a clinic that no
      --   longer has it.
      "movement_type" IN ('DISPENSING', 'CLINICAL_CONSUMPTION', 'TRANSFER_OUT',
                          'DISPOSAL', 'PURCHASE_RETURN')
      AND "quantity_base" < 0
      AND "status_from" IS NOT NULL
      AND "status_to" IS NULL
    ) OR (
      "movement_type" IN ('RESERVATION', 'RELEASE', 'EXPIRY', 'RECALL',
                          'QUARANTINE', 'QUARANTINE_RELEASE', 'DAMAGE')
      AND "quantity_base" > 0
      AND "status_from" IS NOT NULL
      AND "status_to" IS NOT NULL
      AND "status_from" <> "status_to"
    ) OR (
      "movement_type" = 'ADJUSTMENT'
      AND "reason_code" IS NOT NULL
      AND (
        ("quantity_base" > 0 AND "status_from" IS NULL     AND "status_to" IS NOT NULL)
        OR
        ("quantity_base" < 0 AND "status_from" IS NOT NULL AND "status_to" IS NULL)
      )
    )
  );
