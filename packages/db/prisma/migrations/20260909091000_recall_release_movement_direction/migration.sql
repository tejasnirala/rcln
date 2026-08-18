-- ===========================================================================
-- `RECALL_RELEASE` joins the ledger's MOVES group (PI-10).
--
-- A separate migration from the one that added the enum value, for the reason
-- `..090500` states: Postgres refuses to USE a new enum value in the transaction
-- that added it, and Prisma runs each migration inside one.
--
-- ⚠️ UNTIL THIS RUNS THE SYSTEM IS FAIL-CLOSED. A `RECALL_RELEASE` row inserted
--   between the two migrations matches none of the existing CHECK's four shapes
--   and is refused — so the split cannot leave a window in which an unsigned
--   movement commits, only one in which a correct one is refused.
--
-- The constraint is restated in FULL rather than amended, because a CHECK cannot
-- be altered in place. This is the third time it has been rewritten
-- (`..817091000` was the second); the ONLY difference from that version is
-- `RECALL_RELEASE` in the MOVES list.
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
      "movement_type" IN ('DISPENSING', 'CLINICAL_CONSUMPTION', 'TRANSFER_OUT',
                          'DISPOSAL', 'PURCHASE_RETURN')
      AND "quantity_base" < 0
      AND "status_from" IS NOT NULL
      AND "status_to" IS NULL
    ) OR (
      -- ⚠️ `RECALL_RELEASE` IS ADDED HERE AND NOWHERE ELSE IN THIS CONSTRAINT.
      --   Lifting a recall moves quantity from the RECALLED bucket back into
      --   AVAILABLE. The lot has not left the building and nothing new has
      --   arrived, so it is net zero across the two buckets — a MOVE, exactly as
      --   `QUARANTINE_RELEASE` is. Writing it as an ADD would create stock the
      --   clinic never received.
      "movement_type" IN ('RESERVATION', 'RELEASE', 'EXPIRY', 'RECALL',
                          'QUARANTINE', 'QUARANTINE_RELEASE', 'RECALL_RELEASE',
                          'DAMAGE')
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
