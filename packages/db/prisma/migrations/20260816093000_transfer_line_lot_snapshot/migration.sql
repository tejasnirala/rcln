-- ---------------------------------------------------------------------------
-- The receiving branch cannot create its own lot row, so the inter-branch flow
-- stops at receipt. The deeper version of the bug the previous migration fixed,
-- and found the same way — by a test, not by reading.
--
-- THE BUG
--   Receipt has to find or create the RECEIVING branch's row for the same
--   manufacturer's lot: `batches` is branch-scoped, its policy is absolute, and
--   the sender's row therefore cannot be cited by a movement at the receiver.
--   To make the destination row mean the same physical stock it needs the lot
--   NUMBER and the EXPIRY — and `findOrCreateDestinationBatch` read them off the
--   sender's row, which is invisible to the receiver. Not forbidden. Empty.
--
--   `Batch not found`, raised at the moment a storekeeper signs for a delivery
--   they are holding in their hands.
--
-- THE FIX, WHICH IS WHAT A PAPER DELIVERY NOTE HAS ALWAYS DONE
--   The lot's identity travels ON THE LINE. Six columns, written at draft time
--   by the sender — who can read their own lot — and read at receipt by whoever
--   signs for it. Nothing about another branch's shelves becomes readable; the
--   only thing shared is what this document is about.
--
--   The alternative was making `batches` org-scoped, which PI-2 rejected and
--   which is rejected again here: a lot is received AT a site, at a cost, on a
--   date, and two sites receiving the same manufacturer's lot are two receipts.
--   See `@@unique([organizationId, branchId, productId, lotNumber])`.
--
-- ⚠️ THE COST TRAVELS TOO. Stock moved between two sites of ONE organization
--   keeps its value: a receiving branch valuing it at nothing makes every
--   group-level valuation wrong by whatever is in transit, and it is the same
--   tenant's money at both ends. Integer minor units per BASE unit, as
--   everywhere (PI-ADR-010), with the currency beside it — a number with no
--   currency is a number that will be added to a different one.
--
-- ⚠️ ALL SIX ARE NULLABLE, INCLUDING `lot_number`. A line for an UNTRACKED
--   product has no lot at all, and that is the commonest case in the programme.
--   The CHECK below is what ties them together instead: a line that names a lot
--   number must name a source batch, and vice versa.
--
-- No backfill: `stock_transfer_lines` shipped in the migration two before this
-- one and no clinic has a row in it.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_transfer_lines" ADD COLUMN "lot_number"      VARCHAR(128);
ALTER TABLE "stock_transfer_lines" ADD COLUMN "manufactured_on" DATE;
ALTER TABLE "stock_transfer_lines" ADD COLUMN "expires_on"      DATE;
ALTER TABLE "stock_transfer_lines" ADD COLUMN "manufacturer_id" UUID;
ALTER TABLE "stock_transfer_lines" ADD COLUMN "unit_cost_base"  BIGINT;
ALTER TABLE "stock_transfer_lines" ADD COLUMN "currency"        CHAR(3);

ALTER TABLE "stock_transfer_lines"
  ADD CONSTRAINT "stock_transfer_lines_manufacturer_id_fkey"
  FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A line that names a lot must carry its number, and one that does not must not
-- invent one. Without this, a line could arrive at the receiving branch with an
-- expiry and no lot number to attach it to — and the row created from it would
-- be a lot nobody can match against the pack.
ALTER TABLE "stock_transfer_lines"
  ADD CONSTRAINT "stock_transfer_lines_lot_snapshot_complete" CHECK (
    ("batch_id" IS NULL) = ("lot_number" IS NULL)
  );

-- The same rule the batches table carries: a cost with no currency is a number
-- that will be added to a different one.
ALTER TABLE "stock_transfer_lines"
  ADD CONSTRAINT "stock_transfer_lines_cost_has_currency" CHECK (
    "unit_cost_base" IS NULL OR "currency" IS NOT NULL
  );

-- ⚠️ `manufacturer_id` IS A PLAIN FK INTO A POSSIBLY-PLATFORM ROW, SO IT NEEDS A
--   RESTRICTIVE VISIBILITY POLICY LIKE EVERY OTHER ONE IN THIS PROGRAMME.
--   `tenant_isolation` constrains the LINE's organization and says nothing about
--   what it points at; without this a clinic attaches another clinic's private
--   manufacturer to its own transfer line and reads the name back through the
--   join. Mirrored in prisma/rls/enable-rls.sql.
DROP POLICY IF EXISTS manufacturer_visible ON "stock_transfer_lines";
CREATE POLICY manufacturer_visible ON "stock_transfer_lines" AS RESTRICTIVE
  USING      ("stock_transfer_lines"."manufacturer_id" IS NULL
              OR EXISTS (SELECT 1 FROM manufacturers p
                         WHERE p.id = "stock_transfer_lines"."manufacturer_id"
                           AND (p.organization_id IS NULL
                                OR p.organization_id = app_current_org())))
  WITH CHECK ("stock_transfer_lines"."manufacturer_id" IS NULL
              OR EXISTS (SELECT 1 FROM manufacturers p
                         WHERE p.id = "stock_transfer_lines"."manufacturer_id"
                           AND (p.organization_id IS NULL
                                OR p.organization_id = app_current_org())));
