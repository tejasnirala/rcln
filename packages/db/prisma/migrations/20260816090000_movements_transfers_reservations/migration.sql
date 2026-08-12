-- CreateEnum
CREATE TYPE "StockReasonDirection" AS ENUM ('INCREASE', 'DECREASE', 'BOTH');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "AllocationStrategy" AS ENUM ('FEFO', 'FIFO', 'LIFO');

-- AlterEnum
ALTER TYPE "NumberSequenceType" ADD VALUE 'STOCK_TRANSFER';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "allocation_strategy" "AllocationStrategy";

-- CreateTable
CREATE TABLE "stock_reason_codes" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "direction" "StockReasonDirection" NOT NULL DEFAULT 'BOTH',
    "requires_note" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" SMALLINT NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "stock_reason_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "transfer_number" VARCHAR(64),
    "from_branch_id" UUID NOT NULL,
    "to_branch_id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6),
    "dispatched_by_id" UUID,
    "received_at" TIMESTAMPTZ(6),
    "received_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "sent_quantity_base" DECIMAL(18,6) NOT NULL,
    "received_quantity_base" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "destination_batch_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "location_id" UUID NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reference_type" "StockReferenceType" NOT NULL DEFAULT 'MANUAL',
    "reference_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_reason_codes_organization_id_is_active_sort_order_idx" ON "stock_reason_codes"("organization_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reason_codes_organization_id_code_key" ON "stock_reason_codes"("organization_id", "code");

-- CreateIndex
CREATE INDEX "stock_transfers_organization_id_to_branch_id_status_idx" ON "stock_transfers"("organization_id", "to_branch_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_organization_id_from_branch_id_status_creat_idx" ON "stock_transfers"("organization_id", "from_branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_organization_id_transfer_number_key" ON "stock_transfers"("organization_id", "transfer_number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_organization_id_id_key" ON "stock_transfers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_organization_id_transfer_id_idx" ON "stock_transfer_lines"("organization_id", "transfer_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_organization_id_product_id_idx" ON "stock_transfer_lines"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_organization_id_batch_id_idx" ON "stock_transfer_lines"("organization_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_organization_id_transfer_id_product_id_key" ON "stock_transfer_lines"("organization_id", "transfer_id", "product_id", "batch_id", "serial_id");

-- CreateIndex
CREATE INDEX "stock_reservations_organization_id_status_expires_at_idx" ON "stock_reservations"("organization_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "stock_reservations_organization_id_branch_id_product_id_sta_idx" ON "stock_reservations"("organization_id", "branch_id", "product_id", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_organization_id_reference_type_reference_idx" ON "stock_reservations"("organization_id", "reference_type", "reference_id");

-- AddForeignKey
ALTER TABLE "stock_reason_codes" ADD CONSTRAINT "stock_reason_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_from_branch_id_fkey" FOREIGN KEY ("organization_id", "from_branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_to_branch_id_fkey" FOREIGN KEY ("organization_id", "to_branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_from_branch_id_from_locati_fkey" FOREIGN KEY ("organization_id", "from_branch_id", "from_location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_to_branch_id_to_location_i_fkey" FOREIGN KEY ("organization_id", "to_branch_id", "to_location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatched_by_id_fkey" FOREIGN KEY ("dispatched_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_organization_id_transfer_id_fkey" FOREIGN KEY ("organization_id", "transfer_id") REFERENCES "stock_transfers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_organization_id_destination_batch_id_fkey" FOREIGN KEY ("organization_id", "destination_batch_id") REFERENCES "batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_organization_id_serial_id_fkey" FOREIGN KEY ("organization_id", "serial_id") REFERENCES "serials"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organization_id_branch_id_serial_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_released_by_id_fkey" FOREIGN KEY ("released_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- HAND-WRITTEN FROM HERE DOWN.
--
-- Prisma Migrate generates tables, columns, foreign keys and plain indexes. It
-- generates none of: NULLS NOT DISTINCT, CHECK constraints, triggers, seeded
-- rows, or row-level security. This phase depends on all five.
--
-- ⚠️ THE RLS BLOCK AT THE BOTTOM MIRRORS prisma/rls/enable-rls.sql, CHANGED IN
--   THE SAME COMMIT. `pnpm db:rls:check` catches a table with NO policy; nothing
--   catches these two files disagreeing about WHICH policy. If you change one,
--   change the other.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT on the reason-code key.
--
-- ⚠️ WITHOUT THIS EVERY PLATFORM REASON CODE CAN BE INSERTED TWICE, AND NOTHING
--   ERRORS. `organization_id` is NULL on all of them, and under Postgres's
--   default NULLS DISTINCT two rows that are NULL in that column are unique
--   against each other whatever `code` says. The picker would then show
--   `DAMAGED` twice, and the second copy would be the one somebody edits.
--
--   Exactly the rewrite `units_of_measure` and the rest of the PI-1 catalogue
--   already carry, for exactly the same reason. The TENANT rows are unaffected
--   either way — their organization_id is never NULL.
-- ---------------------------------------------------------------------------
DROP INDEX "stock_reason_codes_organization_id_code_key";
CREATE UNIQUE INDEX "stock_reason_codes_organization_id_code_key"
  ON "stock_reason_codes" ("organization_id", "code") NULLS NOT DISTINCT;

-- ⚠️ AND THE SAME ON THE TRANSFER LINE KEY, FOR THE OPPOSITE REASON. `batch_id`
--   and `serial_id` are nullable, so under the default an UNTRACKED product —
--   the commonest case — could be added to one transfer any number of times, and
--   the unique index that is supposed to stop "did they mean the sum or did they
--   type it twice" would never fire.
DROP INDEX "stock_transfer_lines_organization_id_transfer_id_product_id_key";
CREATE UNIQUE INDEX "stock_transfer_lines_organization_id_transfer_id_product_id_key"
  ON "stock_transfer_lines" ("organization_id", "transfer_id", "product_id",
                             "batch_id", "serial_id") NULLS NOT DISTINCT;

-- ⚠️ AND ON THE TRANSFER NUMBER, WHICH IS NULL UNTIL DISPATCH. Every DRAFT
--   transfer has a NULL number, so under NULLS NOT DISTINCT the second draft in
--   an organization would collide with the first. This one is therefore the
--   OTHER way round from the two above — a PARTIAL index, unique only over the
--   rows that have a number.
DROP INDEX "stock_transfers_organization_id_transfer_number_key";
CREATE UNIQUE INDEX "stock_transfers_organization_id_transfer_number_key"
  ON "stock_transfers" ("organization_id", "transfer_number")
  WHERE "transfer_number" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- CHECK constraints.
--
-- In the DATABASE and not only in the service, for the reason the ledger's are:
-- the service is not the only thing that writes here. PI-4's goods receipts,
-- PI-7's dispensing and PI-9's consumption all reach these tables, and a rule
-- enforced in one code path is a rule until somebody writes a second one.
-- ---------------------------------------------------------------------------

-- A reason code is matched EXACTLY against what a caller sends, so the stored
-- form has to be the canonical one. Without this, `Damaged` and `DAMAGED` are
-- two rows, one of which no caller can ever cite.
ALTER TABLE "stock_reason_codes"
  ADD CONSTRAINT "stock_reason_codes_code_shape" CHECK ("code" ~ '^[A-Z0-9_]{2,64}$');

-- ⚠️ A TRANSFER FROM A PLACE TO ITSELF IS NOT AN INTRA-BRANCH TRANSFER, IT IS
--   NOTHING. Same shape as the ledger's `status_from <> status_to` on a MOVE:
--   quantity that leaves a shelf and arrives at the same shelf has not moved,
--   and the pair of ledger rows it would write nets to zero while looking like
--   two real movements in the history a pharmacist reads.
--
--   `to_location_id` is NULL until receipt, and NULL passes — the receiver has
--   not chosen a shelf yet. It is checked again at receipt, in the service,
--   against the value the receiver actually picks.
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_distinct_endpoints" CHECK (
    "to_location_id" IS NULL
    OR "from_branch_id" <> "to_branch_id"
    OR "from_location_id" <> "to_location_id"
  );

-- Every terminal state carries its timestamp, its actor and — for a
-- cancellation — its reason. A transfer cancelled after dispatch has already
-- moved stock twice, and "why" is the only thing that makes the two compensating
-- ledger rows readable a year later.
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_dispatch_recorded" CHECK (
    ("dispatched_at" IS NULL) = ("dispatched_by_id" IS NULL)
  );
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_receipt_recorded" CHECK (
    ("received_at" IS NULL) = ("received_by_id" IS NULL)
  );
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_cancellation_reasoned" CHECK (
    "cancelled_at" IS NULL
    OR ("cancelled_by_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
  );

-- ⚠️ A DISPATCHED TRANSFER HAS A NUMBER AND A DISPATCH TIME, AND A DRAFT HAS
--   NEITHER. This is the constraint that makes "in transit = sent minus
--   received, over DISPATCHED transfers" a safe query: a transfer that reached
--   any post-dispatch state without its `TRANSFER_OUT` legs having been written
--   would contribute phantom stock to that sum for ever, and nothing else would
--   notice. The service writes both in one transaction; this is the layer under
--   it.
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_dispatched_states_complete" CHECK (
    "status" IN ('DRAFT', 'CANCELLED')
    OR ("dispatched_at" IS NOT NULL AND "transfer_number" IS NOT NULL)
  );

-- What the document says was sent is positive, what was signed for is between
-- zero and that.
--
-- ⚠️ OVER-RECEIPT IS REFUSED RATHER THAN ABSORBED. Receiving more than was sent
--   is a data-entry error on this document nine times in ten, and on the tenth
--   it is a genuine discovery of stock — which is an ADJUSTMENT, with a reason
--   code, at the receiving branch. Letting the transfer absorb it would file a
--   discovery as a delivery, and the sending branch's books would never balance.
ALTER TABLE "stock_transfer_lines"
  ADD CONSTRAINT "stock_transfer_lines_quantities_sane" CHECK (
    "sent_quantity_base" > 0
    AND "received_quantity_base" >= 0
    AND "received_quantity_base" <= "sent_quantity_base"
  );

-- A reservation holds a positive quantity, and a terminal one records when it
-- stopped. ⚠️ `released_by_id` is deliberately NOT paired with `released_at`:
-- NULL there is how a screen tells "the sweep gave it back" from "a pharmacist
-- did", and the two mean different things to whoever is asking.
ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_quantity_positive" CHECK ("quantity_base" > 0);
ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_terminal_dated" CHECK (
    "status" = 'ACTIVE' OR "released_at" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- The platform reason codes (PI-3.1).
--
-- ⚠️ SEEDED IN THE MIGRATION AND NOT IN `seed/`, WHICH IS THE OPPOSITE OF WHAT
--   PI-1 DID WITH THE PRODUCT MASTERS AND IS A DIFFERENT KIND OF DATA. OD-4
--   settled that the platform ships NO seeded product data, because a wrong
--   medicine record is a clinical hazard and nobody has signed those off. A
--   reason code is a WORD. "Damaged" is not a claim about any medicine, no
--   regulator has an opinion on it, and getting it wrong costs a clinic a
--   rename. Shipping them here means every clinic — including one restored from
--   a backup, which `seed/` does not run for — has a vocabulary from the moment
--   the schema exists.
--
--   `organization_id` is NULL, so these are platform rows: visible to every
--   tenant, and unwritable by one thanks to the trigger attached below.
--
-- ⚠️ `ON CONFLICT DO NOTHING` MAKES THIS RE-RUNNABLE, WHICH MATTERS BECAUSE
--   `db:reset` REPLAYS MIGRATIONS. Same reason the PI-2 stock grants ended up
--   re-applied after a reset rather than only in the migration.
-- ---------------------------------------------------------------------------
INSERT INTO "stock_reason_codes"
  ("id", "organization_id", "code", "label", "direction", "requires_note",
   "is_active", "sort_order", "created_at", "updated_at")
VALUES
  -- Decreases: where stock actually goes when it is not dispensed.
  (gen_random_uuid(), NULL, 'COUNT_SHORT',      'Counted short',             'DECREASE', false, true, 10, now(), now()),
  (gen_random_uuid(), NULL, 'BREAKAGE',         'Broken or spilt',           'DECREASE', false, true, 20, now(), now()),
  (gen_random_uuid(), NULL, 'COLD_CHAIN_BREACH','Cold chain breach',         'DECREASE', true,  true, 30, now(), now()),
  (gen_random_uuid(), NULL, 'THEFT_OR_LOSS',    'Theft or unexplained loss', 'DECREASE', true,  true, 40, now(), now()),
  (gen_random_uuid(), NULL, 'SAMPLE_TAKEN',     'Taken as a sample',         'DECREASE', false, true, 50, now(), now()),
  (gen_random_uuid(), NULL, 'EXPIRED_ON_SHELF', 'Found expired on the shelf','DECREASE', false, true, 60, now(), now()),
  -- Increases: where stock comes from when it was not bought.
  (gen_random_uuid(), NULL, 'COUNT_OVER',       'Counted over',              'INCREASE', false, true, 70, now(), now()),
  (gen_random_uuid(), NULL, 'FOUND_STOCK',      'Found, previously unrecorded','INCREASE', false, true, 80, now(), now()),
  (gen_random_uuid(), NULL, 'OPENING_BALANCE',  'Opening balance',           'INCREASE', false, true, 90, now(), now()),
  (gen_random_uuid(), NULL, 'DONATION',         'Donated or supplied free',  'INCREASE', false, true, 100, now(), now()),
  -- Both, and the one that has to be explained.
  (gen_random_uuid(), NULL, 'STOCK_TAKE',       'Stock take correction',     'BOTH',     false, true, 110, now(), now()),
  (gen_random_uuid(), NULL, 'DATA_ENTRY_ERROR', 'Correcting a data-entry error','BOTH',  true,  true, 120, now(), now()),
  (gen_random_uuid(), NULL, 'OTHER',            'Other',                     'BOTH',     true,  true, 999, now(), now())
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row-level security. MIRRORS prisma/rls/enable-rls.sql — see the banner.
-- ---------------------------------------------------------------------------

-- `stock_reason_codes` is PLATFORM-EXTENSIBLE: read-permissive, write-strict,
-- plus the trigger that stops a tenant deleting or capturing a platform row.
-- The one table in the inventory domain in this class — see its model comment.
ALTER TABLE "stock_reason_codes" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "stock_reason_codes" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "stock_reason_codes";
CREATE POLICY tenant_isolation ON "stock_reason_codes"
  USING      (organization_id IS NULL OR organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- ⚠️ USING PERMITS A NULL organization_id, SO WITHOUT THIS TRIGGER ANY CLINIC
--   COULD `DELETE FROM stock_reason_codes WHERE organization_id IS NULL` — no
--   WITH CHECK applies to DELETE — or capture a platform row by setting the
--   owner. Both holes and the reasoning are written out in full in the
--   `platform_rows_immutable` migration; this attaches the same function to the
--   eighteenth table.
DROP TRIGGER IF EXISTS platform_rows_immutable ON "stock_reason_codes";
CREATE TRIGGER platform_rows_immutable
  BEFORE UPDATE OR DELETE ON "stock_reason_codes"
  FOR EACH ROW EXECUTE FUNCTION refuse_platform_row_mutation();

-- The three tenant tables get the ordinary org policy.
DO $$
DECLARE
  t text;
  movements text[] := ARRAY[
    'stock_transfers',
    'stock_transfer_lines',
    'stock_reservations'
  ];
BEGIN
  FOREACH t IN ARRAY movements LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

-- A reservation is held at exactly one place, so it is an ordinary member of the
-- `branch_scoped` loop and gets the character-for-character predicate that loop
-- emits. `branch_id` is NOT NULL, so the `IS NULL` half is dead code and is kept
-- for comparability — exactly as on the seven PI-2 tables.
DROP POLICY IF EXISTS branch_isolation ON "stock_reservations";
CREATE POLICY branch_isolation ON "stock_reservations" AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));

-- ⚠️ TRANSFERS ARE THE ONE DOCUMENT WITH TWO BRANCHES, AND THEREFORE THE ONE
--   TABLE THAT CANNOT JOIN THE `branch_scoped` LOOP. It has `from_branch_id` and
--   `to_branch_id` and no `branch_id`, so that loop's predicate would name a
--   column that does not exist and the CREATE POLICY would raise here, at
--   migration time.
--
--   This is NOT a widening of the branch boundary; it is the boundary drawn
--   round a row that has two ends. A transfer from Central Store to Anna Nagar
--   is the business of Central Store and of Anna Nagar and of no third site,
--   which is what the disjunction says. RESTRICTIVE, so it ANDs with
--   tenant_isolation — a PERMISSIVE one would OR, making every transfer in the
--   organization visible to everyone in it, and would pass every single-tenant
--   test.
--
--   What stops a RECEIVER moving the SENDER's quantity is not this policy. It is
--   `stock_ledger.branch_isolation`, which is absolute: the `TRANSFER_OUT` leg
--   carries the sending branch's branch_id and a receiver scoped elsewhere
--   cannot write one. See the StockTransfer model comment for the whole design.
DROP POLICY IF EXISTS transfer_branch_isolation ON "stock_transfers";
CREATE POLICY transfer_branch_isolation ON "stock_transfers" AS RESTRICTIVE
  USING      (from_branch_id = ANY (app_branch_scope())
              OR to_branch_id = ANY (app_branch_scope()))
  WITH CHECK (from_branch_id = ANY (app_branch_scope())
              OR to_branch_id = ANY (app_branch_scope()));

-- ⚠️ THE LINES RESTATE THE PARENT'S PREDICATE RATHER THAN INHERITING IT, AND
--   THAT IS THE `appointment_status_history` TRAP EXACTLY. Postgres evaluates a
--   policy expression with row security DISABLED on the tables it references, so
--   an EXISTS against `stock_transfers` does NOT pick up the policy immediately
--   above — the branch half has to be written out here or it is never asked, and
--   every storekeeper in the organization reads every branch's transfer lines.
--   Measured there, restated here.
--
-- ⚠️ IF `transfer_branch_isolation` ON `stock_transfers` CHANGES, CHANGE THIS.
DROP POLICY IF EXISTS transfer_branch_isolation ON "stock_transfer_lines";
CREATE POLICY transfer_branch_isolation ON "stock_transfer_lines" AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM "stock_transfers" p
                      WHERE p.id = "stock_transfer_lines"."transfer_id"
                        AND p.organization_id = app_current_org()
                        AND (p.from_branch_id = ANY (app_branch_scope())
                             OR p.to_branch_id = ANY (app_branch_scope()))))
  WITH CHECK (EXISTS (SELECT 1 FROM "stock_transfers" p
                      WHERE p.id = "stock_transfer_lines"."transfer_id"
                        AND p.organization_id = app_current_org()
                        AND (p.from_branch_id = ANY (app_branch_scope())
                             OR p.to_branch_id = ANY (app_branch_scope()))));

-- ---------------------------------------------------------------------------
-- The RESTRICTIVE visibility policies, same shape and reasoning as PI-1's and
-- PI-2's.
--
-- Each foreign key below points at a table whose rows MAY be platform rows, so
-- it cannot be a composite `(organization_id, id)` FK — there is no
-- organization_id on the target to compose with. `tenant_isolation` constrains
-- the row's OWN organization and says nothing about what it points AT: without
-- these a clinic puts another clinic's private product on its own transfer line
-- or reservation and reads the name back out through the join.
--
-- ⚠️ RESTRICTIVE. A PERMISSIVE policy here would OR — WIDENING access rather
--   than narrowing it — and would typecheck, deploy and pass every single-tenant
--   test.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS product_visible ON "stock_transfer_lines";
CREATE POLICY product_visible ON "stock_transfer_lines" AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM products p
                      WHERE p.id = "stock_transfer_lines"."product_id"
                        AND (p.organization_id IS NULL
                             OR p.organization_id = app_current_org())))
  WITH CHECK (EXISTS (SELECT 1 FROM products p
                      WHERE p.id = "stock_transfer_lines"."product_id"
                        AND (p.organization_id IS NULL
                             OR p.organization_id = app_current_org())));

DROP POLICY IF EXISTS unit_visible ON "stock_transfer_lines";
CREATE POLICY unit_visible ON "stock_transfer_lines" AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM units_of_measure p
                      WHERE p.id = "stock_transfer_lines"."unit_id"
                        AND (p.organization_id IS NULL
                             OR p.organization_id = app_current_org())))
  WITH CHECK (EXISTS (SELECT 1 FROM units_of_measure p
                      WHERE p.id = "stock_transfer_lines"."unit_id"
                        AND (p.organization_id IS NULL
                             OR p.organization_id = app_current_org())));

DROP POLICY IF EXISTS product_visible ON "stock_reservations";
CREATE POLICY product_visible ON "stock_reservations" AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM products p
                      WHERE p.id = "stock_reservations"."product_id"
                        AND (p.organization_id IS NULL
                             OR p.organization_id = app_current_org())))
  WITH CHECK (EXISTS (SELECT 1 FROM products p
                      WHERE p.id = "stock_reservations"."product_id"
                        AND (p.organization_id IS NULL
                             OR p.organization_id = app_current_org())));

-- ---------------------------------------------------------------------------
-- Grants.
--
-- ⚠️ THE INIT SCRIPT'S BLANKET `GRANT ... ON ALL TABLES` RAN BEFORE THESE TABLES
--   EXISTED, SO THEY HAVE NO GRANTS AT ALL UNTIL THIS RUNS. Same trap PI-2 hit:
--   a table created by a later migration is invisible to a grant issued earlier,
--   and the symptom is a flat `permission denied for table stock_transfers` from
--   the very first request. `scripts/apply-grants.ts` re-applies these after a
--   reset; both are needed, for the reason recorded in the PI-2 changelog.
--
-- Ordinary read/write on all four. ⚠️ None of them is append-only and none is a
--   cache: a transfer is edited while it is a draft, a reservation is released,
--   and a clinic renames its own reason codes. `stock_ledger` and
--   `stock_balances` are the tables with the REVOKEs, and nothing here changes
--   them — every quantity these documents move still goes through
--   `recordMovement`.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_reason_codes"   TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_transfers"      TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_transfer_lines" TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "stock_reservations"   TO rcln_app;
