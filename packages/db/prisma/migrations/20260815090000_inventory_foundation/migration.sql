-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('MAIN_PHARMACY', 'SATELLITE_PHARMACY', 'REFRIGERATOR', 'FREEZER', 'CONTROLLED_CABINET', 'DEPARTMENT_STORE', 'PROCEDURE_ROOM', 'LAB_STORE', 'DENTAL_STORE', 'VETERINARY_STORE', 'CENTRAL_WAREHOUSE', 'CONSIGNMENT', 'DISPOSAL');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'EXPIRED', 'RECALLED', 'DAMAGED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'QUARANTINED', 'BLOCKED', 'EXPIRED', 'DAMAGED', 'RECALLED', 'DISPOSED', 'IN_TRANSIT');

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'ISSUED', 'RETURNED', 'QUARANTINED', 'RECALLED', 'DAMAGED', 'DISPOSED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'TRANSFER_OUT', 'DISPENSING', 'CLINICAL_CONSUMPTION', 'ADJUSTMENT', 'DAMAGE', 'EXPIRY', 'RECALL', 'RETURN', 'DISPOSAL', 'RESERVATION', 'RELEASE', 'QUARANTINE', 'QUARANTINE_RELEASE');

-- CreateEnum
CREATE TYPE "StockReferenceType" AS ENUM ('MANUAL', 'GOODS_RECEIPT', 'PURCHASE_RETURN', 'DISPENSE', 'CONSUMPTION', 'TRANSFER', 'STOCK_TAKE', 'RECALL', 'EXPIRY_SWEEP', 'ONLINE_ORDER');

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_dispensing_point" BOOLEAN NOT NULL DEFAULT false,
    "requires_controlled_access" BOOLEAN NOT NULL DEFAULT false,
    "storage_profile_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_areas" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "storage_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_bins" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "storage_bins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_number" VARCHAR(128) NOT NULL,
    "manufactured_on" DATE,
    "expires_on" DATE,
    "retest_on" DATE,
    "manufacturer_id" UUID,
    "unit_cost_base" BIGINT,
    "currency" CHAR(3),
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "quarantined_at" TIMESTAMPTZ(6),
    "quarantine_reason" TEXT,
    "recalled_at" TIMESTAMPTZ(6),
    "recall_reference" VARCHAR(128),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serials" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_number" VARCHAR(128) NOT NULL,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "current_location_id" UUID,
    "assigned_patient_id" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "expires_on" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "serials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledger" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "tracking_mode" "TrackingMode" NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "status_from" "StockStatus",
    "status_to" "StockStatus",
    "reason_code" VARCHAR(64),
    "reason_note" TEXT,
    "reference_type" "StockReferenceType" NOT NULL,
    "reference_id" UUID,
    "unit_cost_base" BIGINT,
    "currency" CHAR(3),
    "actor_user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "location_id" UUID NOT NULL,
    "status" "StockStatus" NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_locations_organization_id_branch_id_is_active_idx" ON "inventory_locations"("organization_id", "branch_id", "is_active");

-- CreateIndex
CREATE INDEX "inventory_locations_organization_id_branch_id_kind_idx" ON "inventory_locations"("organization_id", "branch_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_organization_id_branch_id_code_key" ON "inventory_locations"("organization_id", "branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_organization_id_id_key" ON "inventory_locations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "storage_areas_organization_id_branch_id_location_id_idx" ON "storage_areas"("organization_id", "branch_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_areas_organization_id_location_id_code_key" ON "storage_areas"("organization_id", "location_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "storage_areas_organization_id_id_key" ON "storage_areas"("organization_id", "id");

-- CreateIndex
CREATE INDEX "storage_bins_organization_id_branch_id_area_id_idx" ON "storage_bins"("organization_id", "branch_id", "area_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_bins_organization_id_area_id_code_key" ON "storage_bins"("organization_id", "area_id", "code");

-- CreateIndex
CREATE INDEX "batches_organization_id_branch_id_product_id_expires_on_idx" ON "batches"("organization_id", "branch_id", "product_id", "expires_on");

-- CreateIndex
CREATE INDEX "batches_organization_id_branch_id_expires_on_idx" ON "batches"("organization_id", "branch_id", "expires_on");

-- CreateIndex
CREATE INDEX "batches_organization_id_product_id_idx" ON "batches"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "batches_organization_id_branch_id_product_id_lot_number_key" ON "batches"("organization_id", "branch_id", "product_id", "lot_number");

-- CreateIndex
CREATE UNIQUE INDEX "batches_organization_id_id_key" ON "batches"("organization_id", "id");

-- CreateIndex
CREATE INDEX "serials_organization_id_branch_id_status_idx" ON "serials"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "serials_organization_id_batch_id_idx" ON "serials"("organization_id", "batch_id");

-- CreateIndex
CREATE INDEX "serials_organization_id_assigned_patient_id_idx" ON "serials"("organization_id", "assigned_patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "serials_organization_id_product_id_serial_number_key" ON "serials"("organization_id", "product_id", "serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "serials_organization_id_id_key" ON "serials"("organization_id", "id");

-- CreateIndex
CREATE INDEX "stock_ledger_organization_id_branch_id_product_id_occurred__idx" ON "stock_ledger"("organization_id", "branch_id", "product_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "stock_ledger_organization_id_batch_id_occurred_at_idx" ON "stock_ledger"("organization_id", "batch_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_ledger_organization_id_reference_type_reference_id_idx" ON "stock_ledger"("organization_id", "reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "stock_ledger_organization_id_serial_id_idx" ON "stock_ledger"("organization_id", "serial_id");

-- CreateIndex
CREATE INDEX "stock_ledger_organization_id_branch_id_occurred_at_idx" ON "stock_ledger"("organization_id", "branch_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_branch_id_location_id_produc_idx" ON "stock_balances"("organization_id", "branch_id", "location_id", "product_id", "status");

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_product_id_status_idx" ON "stock_balances"("organization_id", "product_id", "status");

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_batch_id_idx" ON "stock_balances"("organization_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_organization_id_branch_id_product_id_batch_i_key" ON "stock_balances"("organization_id", "branch_id", "product_id", "batch_id", "serial_id", "location_id", "status");

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_storage_profile_id_fkey" FOREIGN KEY ("storage_profile_id") REFERENCES "storage_requirement_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_areas" ADD CONSTRAINT "storage_areas_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_areas" ADD CONSTRAINT "storage_areas_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_areas" ADD CONSTRAINT "storage_areas_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "inventory_locations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bins" ADD CONSTRAINT "storage_bins_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bins" ADD CONSTRAINT "storage_bins_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_bins" ADD CONSTRAINT "storage_bins_organization_id_area_id_fkey" FOREIGN KEY ("organization_id", "area_id") REFERENCES "storage_areas"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_current_location_id_fkey" FOREIGN KEY ("organization_id", "current_location_id") REFERENCES "inventory_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_assigned_patient_id_fkey" FOREIGN KEY ("organization_id", "assigned_patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_serial_id_fkey" FOREIGN KEY ("organization_id", "serial_id") REFERENCES "serials"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_from_location_id_fkey" FOREIGN KEY ("organization_id", "from_location_id") REFERENCES "inventory_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_to_location_id_fkey" FOREIGN KEY ("organization_id", "to_location_id") REFERENCES "inventory_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_batch_id_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_serial_id_fkey" FOREIGN KEY ("organization_id", "serial_id") REFERENCES "serials"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_location_id_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "inventory_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN FROM HERE DOWN.
--
-- Prisma Migrate generates tables, columns, foreign keys and plain indexes. It
-- does not generate NULLS NOT DISTINCT, partial indexes, CHECK constraints,
-- triggers, GRANTs or row-level security — and this phase depends on all six.
--
-- ⚠️ THE RLS BLOCK AT THE BOTTOM MIRRORS prisma/rls/enable-rls.sql, CHANGED IN
--   THE SAME COMMIT. `pnpm db:rls:check` catches a table with NO policy; nothing
--   catches these two files disagreeing about WHICH policy. If you change one,
--   change the other.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT on the balance key.
--
-- ⚠️ WITHOUT THIS THE CACHE NEVER ACCUMULATES, AND NOTHING ERRORS. `batch_id`
--   and `serial_id` are nullable, and under Postgres's default NULLS DISTINCT
--   two rows that are NULL in either column are unique against each other
--   WHATEVER the rest of the key says. So for every untracked product — the
--   commonest case, `tracking_mode = NONE` — the trigger's ON CONFLICT would
--   match nothing, every movement would INSERT a fresh row instead of adding to
--   the existing one, and `stock_balances` would fill with thousands of rows
--   whose sum is right and whose individual quantities are meaningless. The
--   stock screen would then show the last movement rather than the balance.
--
-- This is the only unique index in this migration that needs the rewrite: every
-- other one is composed entirely of NOT NULL columns.
-- ---------------------------------------------------------------------------
DROP INDEX "stock_balances_organization_id_branch_id_product_id_batch_i_key";
CREATE UNIQUE INDEX "stock_balances_organization_id_branch_id_product_id_batch_i_key"
  ON "stock_balances" (
    "organization_id", "branch_id", "product_id", "batch_id", "serial_id",
    "location_id", "status"
  ) NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- CHECK constraints.
--
-- In the DATABASE and not only in the service, because the service is not the
-- only thing that writes here. Seeds, migrations, imports, the worker and every
-- domain built after this one reach the same tables. A rule enforced in one code
-- path is a rule until somebody writes a second code path — and in this
-- particular table the second code path is guaranteed: PI-3, PI-4, PI-7 and PI-9
-- all insert movements.
-- ---------------------------------------------------------------------------

-- ⚠️ THE SIGN IS A PROPERTY OF THE MOVEMENT TYPE. THIS IS THE CONSTRAINT.
--
--   A caller that COULD pass -5 on a goods receipt is a caller that eventually
--   will, and the resulting row is indistinguishable from a genuine issue in
--   every report that reads the ledger. So the type decides the sign, the type
--   decides which status buckets the row names, and the pairing is checked here
--   rather than trusted to `recordMovement`.
--
--   Three shapes, plus the one member that is deliberately free:
--
--     ADDS      quantity > 0, status_to only.
--     REMOVES   quantity < 0, status_from only.
--     MOVES     quantity > 0, BOTH statuses, and they must differ. The net
--               effect on what the branch holds is zero — the quantity changes
--               which bucket it sits in, not whether it exists.
--     ADJUSTMENT  either direction, and therefore the only member that REQUIRES
--               a reason code. An adjustment with no reason is a number nobody
--               can audit, and adjustments are precisely where shrinkage hides.
--
--   ⚠️ `EXPIRY`, `DAMAGE` AND `RECALL` ARE MOVES RATHER THAN REMOVALS. Expired
--     stock has not left the building: it is on the shelf, undispensable,
--     waiting to be destroyed, and it has to be counted and valued until it is.
--     Writing it as a `−` would make it vanish from every count on the day it
--     expired and leave the clinic unable to say what it is about to dispose of.
--     `DISPOSAL` is the `−` that records the physical departure.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_direction" CHECK (
    (
      "movement_type" IN ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'RETURN')
      AND "quantity_base" > 0
      AND "status_from" IS NULL
      AND "status_to" IS NOT NULL
    ) OR (
      "movement_type" IN ('DISPENSING', 'CLINICAL_CONSUMPTION', 'TRANSFER_OUT', 'DISPOSAL')
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

-- A bucket is a (location, status) pair, so naming one without the other
-- describes half a bucket. The balance trigger reads exactly these four columns
-- and would otherwise insert a row with a NULL location_id — which the NOT NULL
-- would refuse, at insert time, with a message about a column nobody mentioned.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_bucket_complete" CHECK (
    ("status_from" IS NULL) = ("from_location_id" IS NULL)
    AND ("status_to" IS NULL) = ("to_location_id" IS NULL)
  );

-- PI-ADR-014, in the database rather than only in a service.
--
-- `tracking_mode` is DENORMALISED onto the ledger row because a CHECK constraint
-- cannot read another table. It is also the honest thing for history to record:
-- a product that becomes serialised next year did not require a serial for a
-- movement made today, and a joined check would retroactively invalidate rows
-- that were correct when written.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_tracking_satisfied" CHECK (
    ("tracking_mode" = 'NONE')
    OR ("tracking_mode" = 'LOT_BATCH'      AND "batch_id" IS NOT NULL)
    OR ("tracking_mode" = 'SERIAL'         AND "serial_id" IS NOT NULL)
    OR ("tracking_mode" = 'LOT_AND_SERIAL' AND "batch_id" IS NOT NULL
                                           AND "serial_id" IS NOT NULL)
  );

-- What the user typed must point the same way as what was stored. A receipt
-- recorded as "+100 base units, entered as -2 boxes" is a row whose two halves
-- disagree, and the display half is the one a human checks.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_entered_agrees" CHECK (
    "quantity_entered" <> 0
    AND (("quantity_entered" > 0) = ("quantity_base" > 0))
  );

-- A number with no currency is a number that will eventually be added to a
-- different one. Both or neither, on the ledger and on the batch.
ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_cost_has_currency" CHECK (
    (("unit_cost_base" IS NULL) = ("currency" IS NULL))
    AND ("unit_cost_base" IS NULL OR "unit_cost_base" >= 0)
  );

ALTER TABLE "batches"
  ADD CONSTRAINT "batches_cost_has_currency" CHECK (
    (("unit_cost_base" IS NULL) = ("currency" IS NULL))
    AND ("unit_cost_base" IS NULL OR "unit_cost_base" >= 0)
  );

-- A lot that expires before it was made is a typed date, and every FEFO query
-- would put it first for ever.
ALTER TABLE "batches"
  ADD CONSTRAINT "batches_dates_ordered" CHECK (
    ("manufactured_on" IS NULL OR "expires_on" IS NULL OR "expires_on" >= "manufactured_on")
    AND ("manufactured_on" IS NULL OR "retest_on" IS NULL OR "retest_on" >= "manufactured_on")
  );

-- Quarantine states a reason or it states nothing. "Why is this stock held?" is
-- the entire question a quarantine exists to answer.
ALTER TABLE "batches"
  ADD CONSTRAINT "batches_quarantine_reasoned" CHECK (
    ("quarantined_at" IS NULL) = ("quarantine_reason" IS NULL)
  );

ALTER TABLE "serials"
  ADD CONSTRAINT "serials_assignment_dated" CHECK (
    ("assigned_patient_id" IS NULL) = ("assigned_at" IS NULL)
  );

-- ⚠️ THE LAST LINE AGAINST A NEGATIVE SHELF.
--
--   Two pharmacists reading the same available quantity and both committing is
--   the one genuinely contended operation in this domain (the ledger itself is
--   append-only and does not contend). The service takes `SELECT ... FOR UPDATE`
--   on the balance rows inside the committing transaction and re-verifies, so
--   the NORMAL outcome of losing that race is a 409. This is what happens when
--   it does not — a caller that skipped the service, a future domain that wrote
--   its own path, a bug in the re-verify. It fails the transaction rather than
--   committing a shelf holding minus three.
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_non_negative" CHECK ("quantity" >= 0);

-- ---------------------------------------------------------------------------
-- An expiry-controlled product must carry an expiry on its batch.
--
-- A trigger and not a CHECK, because a CHECK cannot see `products`. The column
-- pair it protects is the one the expiry sweep reads: a batch of an
-- expiry-controlled product with a NULL `expires_on` is invisible to the sweep
-- for ever, so it is never quarantined and it never appears in a near-expiry
-- report. It fails silently and permanently, which is why it is refused at
-- write time.
--
-- ⚠️ NOT OWNER-EXEMPT. There is no legitimate writer of such a row — not the
--   app, not a seed, not an import. A seed is in fact the likeliest place to
--   introduce one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION batches_expiry_required() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  controlled boolean;
BEGIN
  IF NEW."expires_on" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT "is_expiry_controlled" INTO controlled
    FROM "products" WHERE "id" = NEW."product_id";

  IF controlled THEN
    RAISE EXCEPTION 'batch % of product % must carry an expiry date',
      NEW."lot_number", NEW."product_id"
      USING ERRCODE = 'check_violation',
            HINT = 'This product is expiry-controlled, so a batch with no expiry would be invisible to the expiry sweep for ever.';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "batches_expiry_required"
  BEFORE INSERT OR UPDATE ON "batches"
  FOR EACH ROW EXECUTE FUNCTION batches_expiry_required();

-- ---------------------------------------------------------------------------
-- `stock_ledger` IS APPEND-ONLY, AND POSTGRES IS WHAT ENFORCES IT.
--
-- The same two independent layers `audit_logs` and `data_access_logs` already
-- carry in this repository, for the same reason: a ledger the application can
-- rewrite is not a ledger. Every other control in this product is a permission
-- check, and every permission check is application code that a bug, an injected
-- query or an endpoint written in a hurry can go around. `rcln_app` simply not
-- holding the privilege cannot be gone around.
--
-- Layer 1: the REVOKE below. It is a fact about the CURRENT grant, and
--   `infra/postgres/init/01-roles-and-extensions.sql` hands out SELECT, INSERT,
--   UPDATE and DELETE on every table plus the same as DEFAULT PRIVILEGES for
--   tables created later. Re-run that init script — which is exactly what a "fix
--   the permissions" script does — and this table is quietly writable again with
--   nothing failing anywhere.
--
-- Layer 2: the trigger, which does not depend on the grant being right.
--
-- ⚠️ THE TRIGGER EXEMPTS THE TABLE OWNER, deliberately, and it is the same
--   decision as RLS being ENABLE rather than FORCE. Two concrete things break
--   under a trigger with no exemption, and neither is hypothetical:
--     · `organizations.id` is referenced ON DELETE CASCADE, so hard-deleting an
--       organization would fail — which the integration suites do, in cleanup,
--       as the owner;
--     · a future partitioning or archival job is DDL plus DML and is impossible
--       for a role that cannot touch the table.
--   So a deletion is not impossible; it is a deliberate act by someone holding
--   the owner credential, outside the application, leaving a trace in the
--   database's own logs rather than happening behind a button.
--
-- INSERT is kept, obviously: `recordMovement` writes through `rcln_app`, inside
-- the transaction whose effect it describes.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "stock_ledger" FROM rcln_app;

CREATE OR REPLACE FUNCTION stock_ledger_is_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  -- The table's own owner passes, exactly as it does under RLS ENABLE.
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'stock_ledger is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A correction is a compensating movement with a reason, never an edit. See PI-ADR-004.';
END
$$;

DROP TRIGGER IF EXISTS "stock_ledger_no_update" ON "stock_ledger";
CREATE TRIGGER "stock_ledger_no_update"
  BEFORE UPDATE ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_is_append_only();

DROP TRIGGER IF EXISTS "stock_ledger_no_delete" ON "stock_ledger";
CREATE TRIGGER "stock_ledger_no_delete"
  BEFORE DELETE ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_is_append_only();

-- ---------------------------------------------------------------------------
-- `stock_balances` IS MAINTAINED BY THIS TRIGGER AND BY NOTHING ELSE.
--
-- PI-ADR-004 rule 2 says "nothing at all writes stock_balances; the trigger
-- does". The REVOKE below is what turns that from an agreement into a fact:
-- `rcln_app` keeps SELECT and holds no INSERT, UPDATE or DELETE, so there is no
-- code path in the application — present or future, correct or not — that can
-- state a quantity directly. The only way a balance changes is that a movement
-- was recorded.
--
-- ⚠️ SECURITY DEFINER, AND THAT IS WHAT MAKES THE REVOKE POSSIBLE. The trigger
--   fires inside `rcln_app`'s INSERT and therefore runs with `rcln_app`'s
--   privileges unless it is owned and defined otherwise. Under SECURITY DEFINER
--   it runs as the table owner, which has the privileges the caller has just
--   been denied.
--
--   It is safe because it invents nothing: every column it writes is copied from
--   the ledger row that has ALREADY passed `tenant_isolation`, `branch_isolation`
--   and `product_visible`. It takes no argument, reads no input other than NEW,
--   and cannot be called except by an insert that already succeeded. The
--   `search_path` is pinned, which is the standard precaution for a function that
--   runs under someone else's statement.
--
--   ⚠️ IT DOES BYPASS RLS ON `stock_balances` (owner + ENABLE, not FORCE). That
--     is the intended and unavoidable consequence, and it is why the function
--     body may not grow a WHERE clause fed by anything except NEW.
--
-- THE ARITHMETIC. Each ledger row is applied as up to two bucket effects:
--
--     status_from IS NOT NULL  ->  (from_location, status_from)  -= |quantity|
--     status_to   IS NOT NULL  ->  (to_location,   status_to)    += |quantity|
--
-- which is a single uniform rule covering receipts, issues, transfers and status
-- transitions alike. The `stock_ledger_direction` CHECK above is what guarantees
-- the columns are populated consistently with the movement type, so this
-- function needs no per-type branch at all — and a per-type branch here is
-- exactly where the trigger and the constraint would drift apart.
--
-- ⚠️ TAKING FROM A BUCKET WITH NO ROW FAILS, AND THAT IS CORRECT. There is
--   nothing to decrement, so the INSERT path writes a negative quantity and
--   `stock_balances_non_negative` refuses it. Issuing stock the clinic does not
--   hold must not succeed just because nobody has ever put any there.
--
-- ⚠️ THIS IS AN UPDATE-THEN-INSERT UPSERT AND NOT `ON CONFLICT DO UPDATE`, AND
--   THE OBVIOUS VERSION IS BROKEN. `INSERT ... VALUES (-30) ON CONFLICT DO
--   UPDATE SET quantity = quantity + EXCLUDED.quantity` reads perfectly and
--   fails every decrement, because Postgres evaluates a table's CHECK
--   constraints against the PROPOSED row before the unique index is consulted
--   for a conflict. So `-30` is rejected by `stock_balances_non_negative`
--   before the arbiter ever gets the chance to redirect it into the existing
--   row holding 100. The failure is not subtle — every dispense raises — but it
--   is invisible to reading, and it is why this was measured rather than
--   reasoned about.
--
-- CONCURRENCY: the UPDATE takes a row lock on the balance, so two movements
-- against the same bucket serialise on it rather than both reading the same
-- starting quantity. The INSERT arm is reached only when no row exists yet, and
-- two transactions racing to create the same bucket resolve through the
-- unique_violation handler — the loser retries and finds the row the winner
-- committed. The retry cap turns a pathological livelock into a raised error
-- rather than a hung connection. PI-2.11 proves the whole thing with fifty
-- parallel writes, mirroring the numbering service's gaplessness test.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON "stock_balances" FROM rcln_app;

CREATE OR REPLACE FUNCTION stock_balances_apply_delta(
  p_org      uuid,
  p_branch   uuid,
  p_product  uuid,
  p_batch    uuid,
  p_serial   uuid,
  p_location uuid,
  p_status   "StockStatus",
  p_delta    numeric
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
DECLARE
  attempts int := 0;
BEGIN
  LOOP
    -- ⚠️ `IS NOT DISTINCT FROM` ON THE TWO NULLABLE COLUMNS. `batch_id = NULL`
    --   is NULL, not true, so a plain `=` would never match an untracked
    --   product's bucket — every movement would fall through to the INSERT arm
    --   and collide on the NULLS NOT DISTINCT unique index for ever.
    UPDATE "stock_balances"
       SET "quantity"   = "quantity" + p_delta,
           "updated_at" = now()
     WHERE "organization_id" = p_org
       AND "branch_id"       = p_branch
       AND "product_id"      = p_product
       AND "batch_id"  IS NOT DISTINCT FROM p_batch
       AND "serial_id" IS NOT DISTINCT FROM p_serial
       AND "location_id"     = p_location
       AND "status"          = p_status;

    IF FOUND THEN
      RETURN;
    END IF;

    BEGIN
      INSERT INTO "stock_balances" (
        "id", "organization_id", "branch_id", "product_id", "batch_id",
        "serial_id", "location_id", "status", "quantity", "updated_at"
      ) VALUES (
        gen_random_uuid(), p_org, p_branch, p_product, p_batch,
        p_serial, p_location, p_status, p_delta, now()
      );
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- Another transaction created this bucket between the UPDATE and the
      -- INSERT. Go round again; the UPDATE will find it this time.
      attempts := attempts + 1;
      IF attempts > 5 THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION stock_balances_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
DECLARE
  magnitude numeric(18,6) := abs(NEW."quantity_base");
BEGIN
  IF NEW."status_from" IS NOT NULL THEN
    PERFORM stock_balances_apply_delta(
      NEW."organization_id", NEW."branch_id", NEW."product_id", NEW."batch_id",
      NEW."serial_id", NEW."from_location_id", NEW."status_from", -magnitude
    );
  END IF;

  IF NEW."status_to" IS NOT NULL THEN
    PERFORM stock_balances_apply_delta(
      NEW."organization_id", NEW."branch_id", NEW."product_id", NEW."batch_id",
      NEW."serial_id", NEW."to_location_id", NEW."status_to", magnitude
    );
  END IF;

  -- AFTER trigger: the return value is discarded.
  RETURN NULL;
END
$$;

-- Neither function is callable by the application. The trigger invokes them
-- under the definer's rights; a route that wanted to state a balance directly
-- would have to go through `recordMovement` like everything else.
REVOKE ALL ON FUNCTION stock_balances_apply_delta(uuid, uuid, uuid, uuid, uuid, uuid, "StockStatus", numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION stock_balances_apply() FROM PUBLIC;

DROP TRIGGER IF EXISTS "stock_balances_apply" ON "stock_ledger";
CREATE TRIGGER "stock_balances_apply"
  AFTER INSERT ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_balances_apply();

-- ===========================================================================
-- ROW-LEVEL SECURITY
--
-- Mirrors the stanzas added to prisma/rls/enable-rls.sql in the same commit.
-- ⚠️ IF YOU CHANGE ONE, CHANGE THE OTHER.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- All seven tables are ORG-SCOPED **AND** BRANCH-SCOPED.
--
-- ⚠️ NOT PLATFORM-EXTENSIBLE, AND NOT ORG-SCOPED ALONE (PI-ADR-003).
--   `organization_id` is NOT NULL on every one of them: a location, a lot, a
--   serial and a movement are facts about one clinic at one site, never
--   catalogue data anybody else may read. And `branch_id` is NOT NULL too, so
--   the branch policy is ABSOLUTE rather than the NULL-tolerant kind that
--   `fee_schedule_entries` needs — a storekeeper scoped to one site cannot read
--   another site's shelves, its costs or what it dispensed.
--
--   The children (`storage_areas`, `storage_bins`) carry both ids themselves
--   rather than inheriting through a parent predicate, which is the call the
--   INVOICE children made and not the one `appointment_status_history` made. An
--   org-only inherited policy under a branch-scoped parent re-opens the branch
--   boundary; carrying both ids makes them ordinary members of both loops, with
--   the composite FK stopping the columns disagreeing with the row they belong to.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  inventory text[] := ARRAY[
    'inventory_locations',
    'storage_areas',
    'storage_bins',
    'batches',
    'serials',
    'stock_ledger',
    'stock_balances'
  ];
BEGIN
  FOREACH t IN ARRAY inventory LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);

    -- RESTRICTIVE so it ANDs with tenant_isolation. A PERMISSIVE policy here
    -- would OR instead and every branch would see every other branch's stock.
    --
    -- ⚠️ THE `branch_id IS NULL OR` HALF IS DEAD CODE HERE, AND IT IS KEPT
    --   ANYWAY. `branch_id` is NOT NULL on all seven tables, so that disjunct
    --   can never be true and the policy is absolute. It is written this way
    --   because it is CHARACTER-FOR-CHARACTER the predicate the `branch_scoped`
    --   loop in prisma/rls/enable-rls.sql emits, and these seven tables are
    --   members of that array. Two files that must not drift are easiest to
    --   compare when they are literally the same string — `invoices` and its
    --   three children, whose branch_id is likewise NOT NULL, already sit in
    --   that loop for the same reason.
    EXECUTE format('DROP POLICY IF EXISTS branch_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY branch_isolation ON %I AS RESTRICTIVE
        USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
        WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The RESTRICTIVE visibility policies. THE highest-risk item in this phase, and
-- the same shape and reasoning as PI-1's.
--
-- Every foreign key below points at a table whose rows MAY be platform rows, so
-- it cannot be a composite `(organization_id, id)` FK — there is no
-- organization_id on the target to compose with, and this side's column is NOT
-- NULL besides. `tenant_isolation` therefore constrains the row's OWN
-- organization and says NOTHING WHATSOEVER about what it points at.
--
-- Without these, a clinic creates a batch, a serial, a balance or a movement
-- naming ANOTHER CLINIC'S PRIVATE PRODUCT and reads the name, the composition
-- and the manufacturer straight back out through the join. It is a valid insert
-- into a table the caller is allowed to write, so nothing else in the system
-- notices.
--
-- ⚠️ RESTRICTIVE, NOT PERMISSIVE. A permissive policy here would widen access
--   rather than narrow it — the exact opposite of the intent — and it would
--   typecheck, deploy and pass every single-tenant test.
--
-- Written as a loop rather than nine copies of the same EXISTS, because the
-- copies are where one of them ends up subtly different.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  i int;
  child text;
  fk text;
  parent text;
  policy_name text;
  nullable boolean;
  predicate text;
  -- child table, FK column on the child, parent table, policy name, FK nullable
  visible text[][] := ARRAY[
    ARRAY['inventory_locations', 'storage_profile_id', 'storage_requirement_profiles', 'storage_profile_visible', 't'],
    ARRAY['batches',             'product_id',         'products',                     'product_visible',         'f'],
    ARRAY['batches',             'manufacturer_id',    'manufacturers',                'manufacturer_visible',    't'],
    ARRAY['serials',             'product_id',         'products',                     'product_visible',         'f'],
    ARRAY['stock_ledger',        'product_id',         'products',                     'product_visible',         'f'],
    ARRAY['stock_ledger',        'unit_id',            'units_of_measure',             'unit_visible',            'f'],
    ARRAY['stock_balances',      'product_id',         'products',                     'product_visible',         'f']
  ];
BEGIN
  FOR i IN 1 .. array_length(visible, 1) LOOP
    child       := visible[i][1];
    fk          := visible[i][2];
    parent      := visible[i][3];
    policy_name := visible[i][4];
    nullable    := visible[i][5]::boolean;

    -- A nullable FK permits NULL: a batch with no manufacturer recorded is
    -- legitimate, and a policy that refused it would make the column unusable.
    predicate := format(
      '%s EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND (p.organization_id IS NULL OR p.organization_id = app_current_org()))',
      CASE WHEN nullable THEN format('%I.%I IS NULL OR', child, fk) ELSE '' END,
      parent, child, fk
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, child);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      policy_name, child, predicate, predicate
    );
  END LOOP;
END
$$;
