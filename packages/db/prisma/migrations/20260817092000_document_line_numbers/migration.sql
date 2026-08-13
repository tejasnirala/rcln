-- ===========================================================================
-- Document lines get an explicit ORDER, and rejection gets the CHECK approval
-- already had. Both found by the PI-4 review.
--
-- ── WHY `line_number` EXISTS ────────────────────────────────────────────────
--
-- ⚠️ WITHOUT IT A DOCUMENT'S LINES RENDER IN AN ARBITRARY ORDER, AND `created_at`
--   CANNOT SUBSTITUTE FOR IT. Lines are written by ONE `createMany`, and
--   `CURRENT_TIMESTAMP` in Postgres is the TRANSACTION timestamp — so every line of
--   one document gets a BYTE-IDENTICAL `created_at`, and the only tie-break left is
--   a random uuid v4.
--
--   ⚠️ WHICH IS WHY `ORDER BY created_at, id` WAS NOT ENOUGH, AND THAT WAS THE FIRST
--     ATTEMPT AT THIS FIX. It makes the order STABLE within a read and still
--     ARBITRARY relative to what somebody typed. Measured rather than reasoned
--     about: the landed-cost apportionment test failed two runs in six against
--     that version, which is exactly the shape of bug that reaches production as
--     "the printed purchase order lists things in a different order every time".
--
--   No money was ever misallocated by it — the apportionment indexes consistently
--   over one array — but a supplier reading a PO, and a storekeeper re-opening a
--   draft delivery, both saw an unstable document.
--
-- Same shape and the same reason as `invoice_items.line_number`, which is the
-- pattern this follows: `SmallInt`, 1-based, unique per document.
--
-- ⚠️ A SEPARATE MIGRATION RATHER THAN AN EDIT TO `20260817090000_procurement`,
--   BECAUSE THAT ONE HAS BEEN APPLIED. Prisma checksums an applied migration
--   including its comments, and editing one in place is refused outright by
--   `migrate dev` — it offers to drop the database instead. Additive is the only
--   safe direction once a migration has run anywhere.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- ⚠️ BACKFILLED DETERMINISTICALLY BEFORE THE COLUMN IS MADE NOT NULL. Existing
--   lines have no order to recover — that is the whole defect — so `created_at`
--   then `id` is the best available reconstruction, and it is at least the same
--   order those rows have been rendering in. Numbering them 1..n per document
--   keeps the unique index below satisfiable.
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_requisition_lines" ADD COLUMN "line_number" SMALLINT;
ALTER TABLE "purchase_order_lines"       ADD COLUMN "line_number" SMALLINT;
ALTER TABLE "goods_receipt_lines"        ADD COLUMN "line_number" SMALLINT;
ALTER TABLE "purchase_return_lines"      ADD COLUMN "line_number" SMALLINT;

UPDATE "purchase_requisition_lines" l SET "line_number" = n.rn
  FROM (SELECT "id", row_number() OVER (PARTITION BY "requisition_id"
                                        ORDER BY "created_at", "id") AS rn
          FROM "purchase_requisition_lines") n
 WHERE n."id" = l."id";

UPDATE "purchase_order_lines" l SET "line_number" = n.rn
  FROM (SELECT "id", row_number() OVER (PARTITION BY "purchase_order_id"
                                        ORDER BY "created_at", "id") AS rn
          FROM "purchase_order_lines") n
 WHERE n."id" = l."id";

UPDATE "goods_receipt_lines" l SET "line_number" = n.rn
  FROM (SELECT "id", row_number() OVER (PARTITION BY "goods_receipt_id"
                                        ORDER BY "created_at", "id") AS rn
          FROM "goods_receipt_lines") n
 WHERE n."id" = l."id";

UPDATE "purchase_return_lines" l SET "line_number" = n.rn
  FROM (SELECT "id", row_number() OVER (PARTITION BY "purchase_return_id"
                                        ORDER BY "created_at", "id") AS rn
          FROM "purchase_return_lines") n
 WHERE n."id" = l."id";

ALTER TABLE "purchase_requisition_lines" ALTER COLUMN "line_number" SET NOT NULL;
ALTER TABLE "purchase_order_lines"       ALTER COLUMN "line_number" SET NOT NULL;
ALTER TABLE "goods_receipt_lines"        ALTER COLUMN "line_number" SET NOT NULL;
ALTER TABLE "purchase_return_lines"      ALTER COLUMN "line_number" SET NOT NULL;

-- ⚠️ THE INDEX NAMES ARE PRISMA'S, NOT HAND-CHOSEN ONES, AND THAT IS NOT COSMETIC.
--   `prisma migrate diff` compares them, so a name Prisma would not have generated
--   shows up as permanent drift and the next `migrate dev` emits an ALTER INDEX
--   nobody asked for. This repository already carries
--   `20260814090000_align_fee_schedule_index_name` for exactly that.
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_requisition_id_l_key"
  ON "purchase_requisition_lines" ("organization_id", "requisition_id", "line_number");
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_purchase_order_id_line_key"
  ON "purchase_order_lines" ("organization_id", "purchase_order_id", "line_number");
CREATE UNIQUE INDEX "goods_receipt_lines_organization_id_goods_receipt_id_line_n_key"
  ON "goods_receipt_lines" ("organization_id", "goods_receipt_id", "line_number");
CREATE UNIQUE INDEX "purchase_return_lines_organization_id_purchase_return_id_li_key"
  ON "purchase_return_lines" ("organization_id", "purchase_return_id", "line_number");

-- ===========================================================================
-- Rejection gets the constraint approval already had.
--
-- ⚠️ THE ASYMMETRY WAS UNINTENTIONAL AND THE SERVICE COMMENT ALREADY ARGUED
--   AGAINST IT. `requisition.service.ts` refuses a rejection by the row's own
--   creator, with a comment explaining that rejecting your own requisition would
--   put "reviewed and refused" on a document nobody reviewed — the audit trail
--   lying in the direction that looks diligent. But only APPROVAL had the CHECK
--   underneath it, so the one layer a later phase cannot forget was missing on
--   exactly the half whose comment says it matters.
--
--   Low impact on its own — a self-rejection is close to a self-cancellation,
--   which `cancelRequisition` already permits — but the point of the constraint is
--   that it survives somebody deleting the service check.
-- ===========================================================================
ALTER TABLE "purchase_requisitions"
  ADD CONSTRAINT "purchase_requisitions_rejecter_is_not_creator" CHECK (
    "rejected_by_id" IS NULL OR "rejected_by_id" <> "created_by_id"
  );
