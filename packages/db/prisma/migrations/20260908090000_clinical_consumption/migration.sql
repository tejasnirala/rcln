-- ---------------------------------------------------------------------------
-- PI-9 — Clinical consumption
--
-- Five new tenant tables, three enums, one column on `charge_requests` and one
-- unique index on `encounter_procedures`.
--
-- ⚠️ WHAT THIS MIGRATION IS FOR: recording what a procedure actually used, and
--   handing the money side to the charge engine PI-8 built and left with no
--   caller. It holds no price, no policy and no tax figure (PI-ADR-005), and it
--   moves no quantity of its own — every figure here is a RECORD of a
--   `stock_ledger` leg written by `recordMovement()` (PI-ADR-004).
--
-- ⚠️ `encounter_procedures` GAINS `@@unique([organization_id, id])`. It is the
--   composite-FK target ADR-0004 requires, and this table is simply the first
--   thing ever to reference it. Adding a unique index to a populated table is
--   the one statement here that touches live data; it is a small clinical child
--   table and the pair is already unique by construction (`id` is a primary
--   key), so the build cannot fail on a duplicate.
--
-- ⚠️ TWO STATEMENTS WERE DELETED FROM WHAT `migrate diff` GENERATED. See the
--   note above the hand-written section.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "ConsumptionAnchorKind" AS ENUM ('ENCOUNTER', 'ENCOUNTER_PROCEDURE', 'LAB_ORDER', 'IMAGING_STUDY');

-- CreateEnum
CREATE TYPE "ConsumptionTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ClinicalConsumptionKind" AS ENUM ('CONSUMPTION', 'ADDITIONAL_CONSUMPTION', 'CONSUMPTION_REVERSAL');

-- AlterTable
ALTER TABLE "charge_requests" ADD COLUMN     "consumption_line_id" UUID;

-- CreateTable
CREATE TABLE "consumption_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ConsumptionTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "consumption_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumption_template_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consumption_template_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_consumptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "kind" "ClinicalConsumptionKind" NOT NULL DEFAULT 'CONSUMPTION',
    "anchor_kind" "ConsumptionAnchorKind" NOT NULL,
    "encounter_id" UUID NOT NULL,
    "encounter_procedure_id" UUID,
    "patient_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "template_id" UUID,
    "recorded_by_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "corrects_consumption_id" UUID,
    "correction_reason" TEXT,
    "notes" TEXT,
    "amended_by_id" UUID,
    "amended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinical_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumption_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "consumption_id" UUID NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "template_line_id" UUID,
    "product_id" UUID NOT NULL,
    "expected_quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "consumption_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumption_allocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "consumption_line_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumption_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consumption_templates_organization_id_item_id_effective_fro_idx" ON "consumption_templates"("organization_id", "item_id", "effective_from");

-- CreateIndex
CREATE INDEX "consumption_templates_organization_id_status_idx" ON "consumption_templates"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_templates_organization_id_item_id_version_key" ON "consumption_templates"("organization_id", "item_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_templates_organization_id_id_key" ON "consumption_templates"("organization_id", "id");

-- CreateIndex
CREATE INDEX "consumption_template_lines_organization_id_template_id_disp_idx" ON "consumption_template_lines"("organization_id", "template_id", "display_order");

-- CreateIndex
CREATE INDEX "consumption_template_lines_organization_id_product_id_idx" ON "consumption_template_lines"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_template_lines_organization_id_template_id_prod_key" ON "consumption_template_lines"("organization_id", "template_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_template_lines_organization_id_id_key" ON "consumption_template_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "clinical_consumptions_organization_id_encounter_id_idx" ON "clinical_consumptions"("organization_id", "encounter_id");

-- CreateIndex
CREATE INDEX "clinical_consumptions_organization_id_encounter_procedure_i_idx" ON "clinical_consumptions"("organization_id", "encounter_procedure_id");

-- CreateIndex
CREATE INDEX "clinical_consumptions_organization_id_patient_id_occurred_a_idx" ON "clinical_consumptions"("organization_id", "patient_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "clinical_consumptions_organization_id_branch_id_occurred_at_idx" ON "clinical_consumptions"("organization_id", "branch_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "clinical_consumptions_organization_id_corrects_consumption__idx" ON "clinical_consumptions"("organization_id", "corrects_consumption_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_consumptions_organization_id_id_key" ON "clinical_consumptions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_consumptions_organization_id_branch_id_id_key" ON "clinical_consumptions"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "consumption_lines_organization_id_consumption_id_idx" ON "consumption_lines"("organization_id", "consumption_id");

-- CreateIndex
CREATE INDEX "consumption_lines_organization_id_product_id_idx" ON "consumption_lines"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "consumption_lines_organization_id_template_line_id_idx" ON "consumption_lines"("organization_id", "template_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_lines_organization_id_consumption_id_line_numbe_key" ON "consumption_lines"("organization_id", "consumption_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_lines_organization_id_id_key" ON "consumption_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_lines_organization_id_branch_id_id_key" ON "consumption_lines"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "consumption_allocations_organization_id_consumption_line_id_idx" ON "consumption_allocations"("organization_id", "consumption_line_id");

-- CreateIndex
CREATE INDEX "consumption_allocations_organization_id_batch_id_idx" ON "consumption_allocations"("organization_id", "batch_id");

-- CreateIndex
CREATE INDEX "consumption_allocations_organization_id_serial_id_idx" ON "consumption_allocations"("organization_id", "serial_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_allocations_organization_id_id_key" ON "consumption_allocations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_allocations_organization_id_branch_id_id_key" ON "consumption_allocations"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "charge_requests_organization_id_consumption_line_id_idx" ON "charge_requests"("organization_id", "consumption_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_procedures_organization_id_id_key" ON "encounter_procedures"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_organization_id_consumption_line_id_fkey" FOREIGN KEY ("organization_id", "consumption_line_id") REFERENCES "consumption_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_templates" ADD CONSTRAINT "consumption_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_templates" ADD CONSTRAINT "consumption_templates_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "clinical_master_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_templates" ADD CONSTRAINT "consumption_templates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_template_lines" ADD CONSTRAINT "consumption_template_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_template_lines" ADD CONSTRAINT "consumption_template_lines_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "consumption_templates"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_template_lines" ADD CONSTRAINT "consumption_template_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_template_lines" ADD CONSTRAINT "consumption_template_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_encounter_id_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "encounters"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_encounter_procedure__fkey" FOREIGN KEY ("organization_id", "encounter_procedure_id") REFERENCES "encounter_procedures"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_branch_id_location_i_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_template_id_fkey" FOREIGN KEY ("organization_id", "template_id") REFERENCES "consumption_templates"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_amended_by_id_fkey" FOREIGN KEY ("amended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_consumptions" ADD CONSTRAINT "clinical_consumptions_organization_id_corrects_consumption_fkey" FOREIGN KEY ("organization_id", "corrects_consumption_id") REFERENCES "clinical_consumptions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "consumption_lines" ADD CONSTRAINT "consumption_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_lines" ADD CONSTRAINT "consumption_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_lines" ADD CONSTRAINT "consumption_lines_organization_id_consumption_id_fkey" FOREIGN KEY ("organization_id", "consumption_id") REFERENCES "clinical_consumptions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_lines" ADD CONSTRAINT "consumption_lines_organization_id_template_line_id_fkey" FOREIGN KEY ("organization_id", "template_line_id") REFERENCES "consumption_template_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_lines" ADD CONSTRAINT "consumption_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_lines" ADD CONSTRAINT "consumption_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_allocations" ADD CONSTRAINT "consumption_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_allocations" ADD CONSTRAINT "consumption_allocations_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_allocations" ADD CONSTRAINT "consumption_allocations_organization_id_consumption_line_i_fkey" FOREIGN KEY ("organization_id", "consumption_line_id") REFERENCES "consumption_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_allocations" ADD CONSTRAINT "consumption_allocations_organization_id_branch_id_location_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_allocations" ADD CONSTRAINT "consumption_allocations_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_allocations" ADD CONSTRAINT "consumption_allocations_organization_id_branch_id_serial_i_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Everything below is HAND-WRITTEN. Prisma Migrate cannot express a partial
-- unique index, a CHECK constraint, a row-level policy or a grant, and every
-- one of them is load-bearing here.
--
-- ⚠️ TWO STATEMENTS WERE DELETED FROM WHAT `migrate diff` GENERATED, and they
--   must be deleted from anything it generates in future: it wants to
--   `ALTER COLUMN "item_id" DROP NOT NULL` on `encounter_procedures` and
--   `encounter_investigations`, because CE-4 tightened both by hand and the
--   Prisma model cannot say "required relation, nullable scalar". PI-7's and
--   PI-8's migration headers say the same thing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Partial uniques. Prisma emits neither.
-- ---------------------------------------------------------------------------

-- ⚠️ ONE CHARGE REQUEST PER CONSUMPTION LINE, AND IT IS THE IDEMPOTENCY
--   GUARANTEE RATHER THAN A TIDINESS ONE — the same treatment
--   `charge_requests_one_per_dispense_line_key` gets. A plain unique is wrong
--   because every pharmacy request carries a NULL here and a clinic has
--   thousands of those.
CREATE UNIQUE INDEX "charge_requests_one_per_consumption_line_key"
  ON "charge_requests" ("organization_id", "consumption_line_id")
  WHERE "consumption_line_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- At most ONE open-ended live version of a procedure's template.
--
-- ⚠️ THIS IS WHAT MAKES "WHICH TEMPLATE IS IN FORCE TODAY" A QUESTION WITH ONE
--   ANSWER. Without it a clinic holds two ACTIVE versions with no `effective_to`
--   and the planner decides which one pre-fills a procedure — the same failure
--   `charge_policy_rules`' NULLS NOT DISTINCT unique exists to stop.
--
--   Overlaps between CLOSED windows are refused in the service instead, because
--   a partial unique cannot see a range and an exclusion constraint over a
--   soft-deleted, versioned table is a bigger hammer than this needs. Stated
--   here so the next reader knows the database is holding one half and
--   `assertNoOverlap` the other.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "consumption_templates_one_open_version_key"
  ON "consumption_templates" ("organization_id", "item_id")
  WHERE "effective_to" IS NULL AND "deleted_at" IS NULL AND "status" <> 'RETIRED';

-- ---------------------------------------------------------------------------
-- CHECK constraints. Added with the tables, while they are empty — a CHECK
-- added later needs a validation pass over live rows.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The anchor resolves to a row that exists.
--
-- ⚠️ THIS IS WHAT MAKES `LAB_ORDER` AND `IMAGING_STUDY` DECLARED-BUT-REFUSED
--   RATHER THAN SILENTLY LEGAL. Neither has a column, because neither table
--   exists in this repository; a row claiming one would be a consumption
--   anchored to nothing, which no report could group and no recall could trace.
--   The enum members are there so the phase that builds the lab needs no enum
--   migration — PI-3 left `StockReservationStatus.CONSUMED` the same way.
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_consumptions"
  ADD CONSTRAINT "clinical_consumptions_anchor_is_resolvable" CHECK (
    ("anchor_kind" = 'ENCOUNTER' AND "encounter_procedure_id" IS NULL)
    OR ("anchor_kind" = 'ENCOUNTER_PROCEDURE' AND "encounter_procedure_id" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- A correction cites what it corrects, and says why.
--
-- ⚠️ A CORRECTION THAT CITES NOTHING IS A SECOND CONSUMPTION WEARING AN
--   ACCOUNTING ENTRY'S CLOTHES. It would double-count against the procedure in
--   every variance report while reading as a fix, and the reversal half would
--   put stock back on the shelf against no original.
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_consumptions"
  ADD CONSTRAINT "clinical_consumptions_correction_cites_original" CHECK (
    ("kind" = 'CONSUMPTION' AND "corrects_consumption_id" IS NULL)
    OR ("kind" <> 'CONSUMPTION'
        AND "corrects_consumption_id" IS NOT NULL
        AND "correction_reason" IS NOT NULL
        AND btrim("correction_reason") <> '')
  );

-- An amendment is attributed or it did not happen. Same shape as
-- `charge_requests_decision_is_attributed`.
ALTER TABLE "clinical_consumptions"
  ADD CONSTRAINT "clinical_consumptions_amendment_is_attributed" CHECK (
    ("amended_by_id" IS NULL AND "amended_at" IS NULL)
    OR ("amended_by_id" IS NOT NULL AND "amended_at" IS NOT NULL)
  );

-- A template's window is ordered, and a template line asks for something.
ALTER TABLE "consumption_templates"
  ADD CONSTRAINT "consumption_templates_dates_ordered" CHECK (
    "effective_to" IS NULL OR "effective_to" >= "effective_from"
  );

ALTER TABLE "consumption_template_lines"
  ADD CONSTRAINT "consumption_template_lines_quantity_positive" CHECK ("quantity" > 0);

-- ---------------------------------------------------------------------------
-- A consumed line moved something, and it knows what it expected.
--
-- ⚠️ `expected_quantity_base >= 0` AND NOT `> 0`. Zero is the ordinary value on
--   a line the clinician ADDED — the template never listed it, so nothing was
--   expected — and on an optional line that was pre-filled at zero. Requiring a
--   positive expectation would make "we used something the template does not
--   mention" unrecordable, which is one of the three cases
--   CLINICAL_CONSUMPTION.md calls normal.
--
-- ⚠️ `quantity_base > 0`, THOUGH. "Used none of it" is a line that should not be
--   written at all, not a zero-quantity ledger leg — and `recordMovement` would
--   refuse the leg anyway.
-- ---------------------------------------------------------------------------
ALTER TABLE "consumption_lines"
  ADD CONSTRAINT "consumption_lines_quantities_valid" CHECK (
    "quantity_entered" > 0 AND "quantity_base" > 0 AND "expected_quantity_base" >= 0
  );

-- ---------------------------------------------------------------------------
-- An override says why, on both tables that carry one.
--
-- ⚠️ THE FLAG IS DERIVED SERVER-SIDE FROM THE TWO NUMBERS DISAGREEING, and this
--   CHECK is the second half of that control: a client that set the flag without
--   a reason is refused by the database, and a client that set neither is
--   corrected by the service. "Why did the dentist use three pairs" and "why did
--   it come out of the lot expiring next week" are both questions that get
--   asked.
-- ---------------------------------------------------------------------------
ALTER TABLE "consumption_lines"
  ADD CONSTRAINT "consumption_lines_override_is_explained" CHECK (
    NOT "is_override"
    OR ("override_reason" IS NOT NULL AND btrim("override_reason") <> '')
  );

ALTER TABLE "consumption_allocations"
  ADD CONSTRAINT "consumption_allocations_override_is_explained" CHECK (
    NOT "is_override"
    OR ("override_reason" IS NOT NULL AND btrim("override_reason") <> '')
  );

ALTER TABLE "consumption_allocations"
  ADD CONSTRAINT "consumption_allocations_quantity_positive" CHECK ("quantity_base" > 0);

-- ---------------------------------------------------------------------------
-- ⚠️ `charge_requests_reference_matches_kind` IS REPLACED, NOT ADDED TO.
--
-- PI-8 wrote its third branch as "an INVENTORY request carries neither yet —
-- PI-9's consumption table does not exist, and its column arrives in the
-- migration that creates it". This is that migration, and leaving the old
-- constraint in place would refuse every row PI-9 writes: it requires
-- `dispense_line_id IS NULL AND dispense_return_line_id IS NULL` for a
-- non-PHARMACY source and says nothing that permits a consumption reference,
-- but it also says nothing that REQUIRES one — so an INVENTORY request citing
-- nothing at all would pass, which is precisely the combination PI-8 said it
-- was leaving audible rather than legal.
--
-- ⚠️ ONE COLUMN SERVES BOTH DIRECTIONS, unlike pharmacy's two. A consumption
--   reversal is another `clinical_consumptions` row (`CONSUMPTION_REVERSAL`)
--   with its own lines, not a separate return table, so the REVERSAL cites a
--   consumption line exactly as the SUPPLY does and `kind` is what distinguishes
--   them. Pharmacy needs two columns because a dispense return IS a different
--   table.
--
-- Editing PI-8's migration in place was the alternative and is forbidden —
-- Prisma checksums an applied migration.
-- ---------------------------------------------------------------------------
ALTER TABLE "charge_requests" DROP CONSTRAINT "charge_requests_reference_matches_kind";

ALTER TABLE "charge_requests" ADD CONSTRAINT "charge_requests_reference_matches_kind" CHECK (
  ("source_type" = 'PHARMACY' AND "kind" = 'SUPPLY'
     AND "dispense_line_id" IS NOT NULL
     AND "dispense_return_line_id" IS NULL
     AND "consumption_line_id" IS NULL)
  OR ("source_type" = 'PHARMACY' AND "kind" = 'REVERSAL'
     AND "dispense_return_line_id" IS NOT NULL
     AND "dispense_line_id" IS NULL
     AND "consumption_line_id" IS NULL)
  OR ("source_type" = 'INVENTORY'
     AND "consumption_line_id" IS NOT NULL
     AND "dispense_line_id" IS NULL
     AND "dispense_return_line_id" IS NULL)
);

-- ===========================================================================
-- RLS. ⚠️ APPENDED HERE AND RESTATED IN `prisma/rls/enable-rls.sql`, and the two
--   must not drift — `db:rls:check` reads the database, so a policy that exists
--   only in one file is a policy that disappears on the next `db:reset`.
--
-- ⚠️ A MISSING POLICY PRODUCES NO ERROR AND BREAKS NO SINGLE-TENANT TEST. It
--   just starts returning other clinics' rows — and `clinical_consumptions`
--   holds a named patient beside an implant's serial number.
--
-- The wording is kept identical to `enable-rls.sql` so the two can be diffed by
-- eye.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The org predicate, on all five.
--
-- ⚠️ THE TWO TEMPLATE TABLES ARE ORG-SCOPED ONLY AND ARE NOT IN THE BRANCH LOOP
--   BELOW. Neither has a `branch_id` column: "a root canal uses two pairs of
--   gloves" is how this ORGANIZATION practises, the same call
--   `charge_policy_rules` makes about billability, and the branch predicate
--   would name a column that does not exist and raise at migration time.
--
--   THE COST, STATED: a branch-scoped member reads the whole organization's
--   consumption templates. Intended — they follow them — and it is why nothing
--   branch-confidential may be added to those two tables.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  consumption_tables text[] := ARRAY[
    'consumption_templates',
    'consumption_template_lines',
    'clinical_consumptions',
    'consumption_lines',
    'consumption_allocations'
  ];
BEGIN
  FOREACH t IN ARRAY consumption_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- ENABLE, not FORCE: the owner must keep bypassing so migrations and seeds
    -- work (ADR-0003).
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

-- ---------------------------------------------------------------------------
-- The branch predicate, on the three that record what happened at a place.
--
-- ⚠️ EVERY ONE OF THESE `branch_id`s IS NOT NULL, so the `IS NULL OR` half is
--   dead code here — kept verbatim because it is the shared shape and a
--   hand-narrowed copy is how the two files start to drift. Compare
--   `product_prices`, where the same half is live.
--
-- ⚠️ AND THE CHILDREN CARRY THEIR OWN `branch_id` RATHER THAN INHERITING ONE
--   THROUGH A PARENT PREDICATE. An org-only inherited policy under a
--   branch-scoped parent re-opens the branch boundary — permissive policies OR
--   together and a policy expression does not pick up the parent's own policy to
--   close it. The invoice-children call, made again.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  branch_tables text[] := ARRAY[
    'clinical_consumptions',
    'consumption_lines',
    'consumption_allocations'
  ];
BEGIN
  FOREACH t IN ARRAY branch_tables LOOP
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
-- The RESTRICTIVE `*_visible` policies — KI-3, the risk `db:rls:check`
-- structurally cannot see.
--
-- Three plain FKs into platform-extensible tables across two tables here:
-- `consumption_templates.item_id` into `clinical_master_items`, and
-- `product_id` / `unit_id` on both line tables. `tenant_isolation` constrains
-- the CHILD side and says nothing about the parent side, so without these a
-- clinic attaches another clinic's private procedure word or private product to
-- its own row and reads the name straight back through the join that renders
-- it.
--
-- ⚠️ THIS EXACT CLASS HAS PRODUCED A CRITICAL IN THREE SEPARATE PHASES, most
--   recently on `dispense_lines.substituted_for_product_id`, which PI-8 closed
--   only because somebody swept for it deliberately.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS item_visible ON consumption_templates;
CREATE POLICY item_visible ON consumption_templates AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM clinical_master_items i
    WHERE i.id = consumption_templates.item_id
      AND (i.organization_id IS NULL OR i.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM clinical_master_items i
    WHERE i.id = consumption_templates.item_id
      AND (i.organization_id IS NULL OR i.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS product_visible ON consumption_template_lines;
CREATE POLICY product_visible ON consumption_template_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = consumption_template_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = consumption_template_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS unit_visible ON consumption_template_lines;
CREATE POLICY unit_visible ON consumption_template_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = consumption_template_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = consumption_template_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS product_visible ON consumption_lines;
CREATE POLICY product_visible ON consumption_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = consumption_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = consumption_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS unit_visible ON consumption_lines;
CREATE POLICY unit_visible ON consumption_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = consumption_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = consumption_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- Grants. The application connects as rcln_app, which owns nothing.
--
-- ⚠️ RESTATED IN `prisma/rls/grant-app.sql` TOO. `ALTER DEFAULT PRIVILEGES`
--   re-grants on the next `db:reset`, and PI-8 found a REVOKE that only failed
--   AFTER a reset — which is why the grant file, not this one, is the file that
--   decides what `rcln_app` holds in a fresh database.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "consumption_templates",
  "consumption_template_lines",
  "clinical_consumptions",
  "consumption_lines",
  "consumption_allocations"
TO rcln_app;
