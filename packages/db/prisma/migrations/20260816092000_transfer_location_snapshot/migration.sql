-- ---------------------------------------------------------------------------
-- The receiving branch cannot read its own delivery note. Found by
-- `stock-movements.test.ts`, not by reading.
--
-- THE BUG
--   `stock_transfers` is visible to BOTH ends — that is what
--   `transfer_branch_isolation` is for. `inventory_locations` is visible to ONE,
--   and its `branch_isolation` policy is absolute. So a storekeeper at the
--   receiving branch loads the transfer, joins to `from_location_id`, and gets
--   NULL: not an error, not a permission failure, just nothing. "Where did this
--   come from" — the first question anyone asks when unpacking a box — is
--   unanswerable at the exact end that needs to ask it.
--
--   It typechecks. The FK is valid, the row exists, and the policy is doing
--   precisely what it was written to do.
--
-- WHY NOT WEAKEN THE LOCATION POLICY
--   Because it would open every branch's shelves — their names, their kinds,
--   their controlled-access flags — to every other branch on the platform, to
--   serve one line on one screen. The transfer document is deliberately shared
--   between two branches; the location TABLE is deliberately not.
--
-- SO: SNAPSHOT THE NAME ONTO THE DOCUMENT
--   It shares exactly the fact the document is about and nothing else, and it is
--   the more honest record besides — a shelf renamed or taken out of use next
--   year must not rewrite a delivery note from this one. Same shape and the same
--   reasoning as the practitioner snapshot on `invoices`, and as
--   `stock_ledger.tracking_mode`.
--
--   The ids stay, composite-FK'd, so the branch that OWNS a shelf still resolves
--   a live row for its own screens.
--
-- ⚠️ BACKFILLED AS THE OWNER, WHICH BYPASSES RLS AND IS THE ONLY WAY THIS COULD
--   WORK. The update has to read both branches' locations at once, which no
--   tenant connection may do. Migrations run as `rcln_owner`; the application
--   never performs this join and now never needs to.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_transfers" ADD COLUMN "from_location_name" VARCHAR(255);
ALTER TABLE "stock_transfers" ADD COLUMN "to_location_name"   VARCHAR(255);

UPDATE "stock_transfers" t
   SET "from_location_name" = l."name"
  FROM "inventory_locations" l
 WHERE l."id" = t."from_location_id";

UPDATE "stock_transfers" t
   SET "to_location_name" = l."name"
  FROM "inventory_locations" l
 WHERE l."id" = t."to_location_id";

-- Any row the backfill could not name has a location that no longer exists,
-- which the RESTRICT foreign key makes unreachable. The fallback keeps the
-- NOT NULL honest rather than leaving a hole for a case that cannot occur.
UPDATE "stock_transfers"
   SET "from_location_name" = 'Unknown shelf'
 WHERE "from_location_name" IS NULL;

ALTER TABLE "stock_transfers" ALTER COLUMN "from_location_name" SET NOT NULL;
