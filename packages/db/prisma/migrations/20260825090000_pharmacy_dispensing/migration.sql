-- ---------------------------------------------------------------------------
-- PI-7 — Pharmacy dispensing, and the decision snapshot PI-ADR-008 requires.
--
-- ⚠️ TWO STATEMENTS PRISMA GENERATED WERE DELETED FROM THIS FILE BY HAND, AND
--   DELETING THEM WAS THE POINT. `prisma migrate diff` wanted to
--   `ALTER COLUMN "item_id" DROP NOT NULL` on `encounter_procedures` and
--   `encounter_investigations` — because CE-4 tightened both in hand-written SQL
--   that the Prisma schema cannot express. Letting a later diff carry them along
--   would silently revert a deliberate constraint on the clinical record, which
--   is the classic way generated migrations undo hand-written ones. Any future
--   diff in this repository will want to do it again; delete it again.
--
-- What is hand-written below the generated section: the CHECK constraints, the
-- append-only enforcement on `regulatory_decisions`, and the RLS policies for
-- the seven new tables (mirrored in `prisma/rls/enable-rls.sql`, which is the
-- file `db:rls:check` reads).
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "PrescriptionFulfilmentStatus" AS ENUM ('NEW', 'VERIFIED', 'PARTIALLY_DISPENSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DispenseKind" AS ENUM ('PRESCRIPTION', 'COUNTER_SALE');

-- CreateEnum
CREATE TYPE "DispenseStatus" AS ENUM ('DISPENSED', 'PARTIALLY_RETURNED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DispenseReturnDisposition" AS ENUM ('RESTOCKED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "RegulatoryDecisionOutcome" AS ENUM ('PERMITTED', 'PERMITTED_WITH_CONDITIONS', 'REFUSED', 'UNDETERMINED');

-- CreateTable
CREATE TABLE "prescription_fulfilments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "status" "PrescriptionFulfilmentStatus" NOT NULL DEFAULT 'VERIFIED',
    "verified_by_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prescription_fulfilments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispenses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "dispense_number" VARCHAR(64) NOT NULL,
    "kind" "DispenseKind" NOT NULL,
    "status" "DispenseStatus" NOT NULL DEFAULT 'DISPENSED',
    "encounter_id" UUID,
    "patient_id" UUID,
    "location_id" UUID NOT NULL,
    "dispensed_by_id" UUID NOT NULL,
    "dispensed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dispenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "dispense_id" UUID NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "encounter_prescription_id" UUID,
    "product_id" UUID NOT NULL,
    "substituted_for_product_id" UUID,
    "substitution_reason" TEXT,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "returned_quantity_base" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "regulatory_decision_id" UUID NOT NULL,
    "label_instructions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dispense_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_allocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "dispense_line_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispense_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_returns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "dispense_id" UUID NOT NULL,
    "disposition" "DispenseReturnDisposition" NOT NULL DEFAULT 'QUARANTINED',
    "location_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "returned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_id" UUID NOT NULL,
    "regulatory_decision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dispense_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispense_return_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "dispense_return_id" UUID NOT NULL,
    "dispense_line_id" UUID NOT NULL,
    "dispense_allocation_id" UUID,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispense_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "transaction" "RegulatoryTransactionType" NOT NULL,
    "outcome" "RegulatoryDecisionOutcome" NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(8),
    "lowest_pack_maturity" "RulePackMaturity",
    "was_enforced" BOOLEAN NOT NULL DEFAULT false,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "pack_versions" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "conditions" JSONB NOT NULL,
    "rule_codes" TEXT[],
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulatory_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prescription_fulfilments_organization_id_branch_id_status_c_idx" ON "prescription_fulfilments"("organization_id", "branch_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_fulfilments_organization_id_encounter_id_key" ON "prescription_fulfilments"("organization_id", "encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_fulfilments_organization_id_id_key" ON "prescription_fulfilments"("organization_id", "id");

-- CreateIndex
CREATE INDEX "dispenses_organization_id_branch_id_dispensed_at_idx" ON "dispenses"("organization_id", "branch_id", "dispensed_at" DESC);

-- CreateIndex
CREATE INDEX "dispenses_organization_id_encounter_id_idx" ON "dispenses"("organization_id", "encounter_id");

-- CreateIndex
CREATE INDEX "dispenses_organization_id_patient_id_dispensed_at_idx" ON "dispenses"("organization_id", "patient_id", "dispensed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dispenses_organization_id_dispense_number_key" ON "dispenses"("organization_id", "dispense_number");

-- CreateIndex
CREATE UNIQUE INDEX "dispenses_organization_id_id_key" ON "dispenses"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dispenses_organization_id_branch_id_id_key" ON "dispenses"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "dispense_lines_organization_id_dispense_id_idx" ON "dispense_lines"("organization_id", "dispense_id");

-- CreateIndex
CREATE INDEX "dispense_lines_organization_id_product_id_idx" ON "dispense_lines"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "dispense_lines_organization_id_encounter_prescription_id_idx" ON "dispense_lines"("organization_id", "encounter_prescription_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_lines_organization_id_dispense_id_line_number_key" ON "dispense_lines"("organization_id", "dispense_id", "line_number");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_lines_organization_id_id_key" ON "dispense_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_lines_organization_id_branch_id_id_key" ON "dispense_lines"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "dispense_allocations_organization_id_dispense_line_id_idx" ON "dispense_allocations"("organization_id", "dispense_line_id");

-- CreateIndex
CREATE INDEX "dispense_allocations_organization_id_batch_id_idx" ON "dispense_allocations"("organization_id", "batch_id");

-- CreateIndex
CREATE INDEX "dispense_allocations_organization_id_serial_id_idx" ON "dispense_allocations"("organization_id", "serial_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_allocations_organization_id_id_key" ON "dispense_allocations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_allocations_organization_id_branch_id_id_key" ON "dispense_allocations"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "dispense_returns_organization_id_dispense_id_idx" ON "dispense_returns"("organization_id", "dispense_id");

-- CreateIndex
CREATE INDEX "dispense_returns_organization_id_branch_id_returned_at_idx" ON "dispense_returns"("organization_id", "branch_id", "returned_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dispense_returns_organization_id_id_key" ON "dispense_returns"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_returns_organization_id_branch_id_id_key" ON "dispense_returns"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "dispense_return_lines_organization_id_dispense_return_id_idx" ON "dispense_return_lines"("organization_id", "dispense_return_id");

-- CreateIndex
CREATE INDEX "dispense_return_lines_organization_id_dispense_line_id_idx" ON "dispense_return_lines"("organization_id", "dispense_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispense_return_lines_organization_id_id_key" ON "dispense_return_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "regulatory_decisions_organization_id_branch_id_evaluated_at_idx" ON "regulatory_decisions"("organization_id", "branch_id", "evaluated_at" DESC);

-- CreateIndex
CREATE INDEX "regulatory_decisions_organization_id_product_id_evaluated_a_idx" ON "regulatory_decisions"("organization_id", "product_id", "evaluated_at" DESC);

-- CreateIndex
CREATE INDEX "regulatory_decisions_organization_id_outcome_idx" ON "regulatory_decisions"("organization_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_decisions_organization_id_id_key" ON "regulatory_decisions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_prescriptions_organization_id_id_key" ON "encounter_prescriptions"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_organization_id_encounter_id_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "encounters"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_organization_id_encounter_id_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "encounters"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_dispensed_by_id_fkey" FOREIGN KEY ("dispensed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_organization_id_dispense_id_fkey" FOREIGN KEY ("organization_id", "dispense_id") REFERENCES "dispenses"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_substituted_for_product_id_fkey" FOREIGN KEY ("substituted_for_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_organization_id_encounter_prescription_id_fkey" FOREIGN KEY ("organization_id", "encounter_prescription_id") REFERENCES "encounter_prescriptions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_organization_id_regulatory_decision_id_fkey" FOREIGN KEY ("organization_id", "regulatory_decision_id") REFERENCES "regulatory_decisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_organization_id_dispense_line_id_fkey" FOREIGN KEY ("organization_id", "dispense_line_id") REFERENCES "dispense_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_organization_id_branch_id_serial_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_organization_id_dispense_id_fkey" FOREIGN KEY ("organization_id", "dispense_id") REFERENCES "dispenses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_returns" ADD CONSTRAINT "dispense_returns_organization_id_regulatory_decision_id_fkey" FOREIGN KEY ("organization_id", "regulatory_decision_id") REFERENCES "regulatory_decisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_return_lines" ADD CONSTRAINT "dispense_return_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_return_lines" ADD CONSTRAINT "dispense_return_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_return_lines" ADD CONSTRAINT "dispense_return_lines_organization_id_dispense_return_id_fkey" FOREIGN KEY ("organization_id", "dispense_return_id") REFERENCES "dispense_returns"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_return_lines" ADD CONSTRAINT "dispense_return_lines_organization_id_dispense_line_id_fkey" FOREIGN KEY ("organization_id", "dispense_line_id") REFERENCES "dispense_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispense_return_lines" ADD CONSTRAINT "dispense_return_lines_organization_id_dispense_allocation__fkey" FOREIGN KEY ("organization_id", "dispense_allocation_id") REFERENCES "dispense_allocations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_decisions" ADD CONSTRAINT "regulatory_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_decisions" ADD CONSTRAINT "regulatory_decisions_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_decisions" ADD CONSTRAINT "regulatory_decisions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_decisions" ADD CONSTRAINT "regulatory_decisions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- CHECK constraints: the rules the type system cannot hold
--
-- Every one of these is a statement the SERVICE also makes. That is not
-- duplication — the service explains itself to a human with a sentence, and the
-- constraint holds when a later import, a fixture or a second code path forgets
-- to. PI-2 through PI-4 each found one of those.
-- ---------------------------------------------------------------------------

-- A prescription dispense has a prescription and therefore a patient; a counter
-- sale has neither an encounter nor (usually) a patient. ⚠️ THE PATIENT IS
-- NULLABLE ONLY ON THE COUNTER PATH: a supply against a prescription that could
-- not say whose it was would be unattributable in exactly the register an
-- inspector reads.
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_prescription_has_patient"
  CHECK (
    ("kind" = 'PRESCRIPTION' AND "encounter_id" IS NOT NULL AND "patient_id" IS NOT NULL)
    OR ("kind" = 'COUNTER_SALE' AND "encounter_id" IS NULL)
  );

-- Quantities are positive on this surface. The SIGN of the ledger leg is a
-- property of `DISPENSING` and is CHECKed on `stock_ledger`; a negative here
-- would be a supply that put stock back.
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_quantities_positive"
  CHECK ("quantity_entered" > 0 AND "quantity_base" > 0);

-- Returned can never exceed supplied, and cannot go negative.
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_returned_within_dispensed"
  CHECK ("returned_quantity_base" >= 0 AND "returned_quantity_base" <= "quantity_base");

-- A substitution says WHY, and is a substitution of something ELSE. "Substituted
-- X for X" is a data-entry accident that reads as a real clinical decision.
ALTER TABLE "dispense_lines" ADD CONSTRAINT "dispense_lines_substitution_is_explained"
  CHECK (
    "substituted_for_product_id" IS NULL
    OR ("substitution_reason" IS NOT NULL AND "substituted_for_product_id" <> "product_id")
  );

ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_quantity_positive"
  CHECK ("quantity_base" > 0);

-- Overruling FEFO is allowed and is never silent. See the model comment.
ALTER TABLE "dispense_allocations" ADD CONSTRAINT "dispense_allocations_override_is_explained"
  CHECK ("is_override" = false OR "override_reason" IS NOT NULL);

ALTER TABLE "dispense_return_lines" ADD CONSTRAINT "dispense_return_lines_quantity_positive"
  CHECK ("quantity_base" > 0);

-- `NEW` is a queue rendering, never a stored state — a prescription with no row
-- IS new. Storing it would give the same fact two representations.
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_status_is_stored"
  CHECK ("status" <> 'NEW');

-- Who verified it and when, whenever it is verified; likewise cancelled. A
-- verification attributed to nobody is not a verification.
ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_verified_is_attributed"
  CHECK (
    "status" = 'CANCELLED'
    OR ("verified_by_id" IS NOT NULL AND "verified_at" IS NOT NULL)
  );

ALTER TABLE "prescription_fulfilments" ADD CONSTRAINT "prescription_fulfilments_cancelled_is_attributed"
  CHECK (
    "status" <> 'CANCELLED'
    OR ("cancelled_by_id" IS NOT NULL AND "cancelled_at" IS NOT NULL)
  );

ALTER TABLE "regulatory_decisions" ADD CONSTRAINT "regulatory_decisions_quantity_not_negative"
  CHECK ("quantity_base" >= 0);

-- ⚠️ A DECISION THAT DID NOT PERMIT AND THAT WAS ENFORCED IS A CONTRADICTION IN
--   THIS TABLE, BECAUSE THE TRANSACTION WOULD HAVE BEEN REFUSED AND ROLLED BACK.
--   `was_enforced` records that the pack was AT `PRODUCTION_ENABLED` and the
--   answer was acted on; a stored row therefore always permitted, or was not
--   enforceable. Written down as a constraint because the day enforcement is
--   switched on for a jurisdiction, this is the assumption that breaks first.
ALTER TABLE "regulatory_decisions" ADD CONSTRAINT "regulatory_decisions_enforced_rows_permitted"
  CHECK (
    "was_enforced" = false
    OR "outcome" IN ('PERMITTED', 'PERMITTED_WITH_CONDITIONS')
  );

-- ---------------------------------------------------------------------------
-- `regulatory_decisions` IS APPEND-ONLY, ENFORCED TWICE
--
-- The same pair `audit_logs`, `data_access_logs` and `stock_ledger` already
-- carry, and for a sharper reason than any of them: this row is what a clinic
-- shows an inspector to say "these are the rules we applied, and this is what
-- they said, on the day we supplied it". A row that can be edited afterwards is
-- worth nothing as evidence, and PI-ADR-008 turns on it.
--
-- Layer 1: `rcln_app` holds no UPDATE and no DELETE, so no code path in the
--          application — present or future, correct or not — can rewrite one.
-- Layer 2: a trigger refuses both anyway, so a stray GRANT does not silently
--          reopen it.
--
-- ⚠️ THE TRIGGER EXEMPTS THE TABLE OWNER, exactly as the other three do and for
--   the same reasons: `organizations.id` cascades on delete and the integration
--   suites hard-delete organizations in cleanup as the owner.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "regulatory_decisions" FROM rcln_app;

CREATE OR REPLACE FUNCTION regulatory_decisions_are_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) = current_user THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'regulatory_decisions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A decision is a snapshot of what the rules said at one moment. A new answer is a new evaluation. See PI-ADR-008.';
END
$$;

DROP TRIGGER IF EXISTS "regulatory_decisions_no_update" ON "regulatory_decisions";
CREATE TRIGGER "regulatory_decisions_no_update"
  BEFORE UPDATE ON "regulatory_decisions"
  FOR EACH ROW EXECUTE FUNCTION regulatory_decisions_are_append_only();

DROP TRIGGER IF EXISTS "regulatory_decisions_no_delete" ON "regulatory_decisions";
CREATE TRIGGER "regulatory_decisions_no_delete"
  BEFORE DELETE ON "regulatory_decisions"
  FOR EACH ROW EXECUTE FUNCTION regulatory_decisions_are_append_only();

-- ---------------------------------------------------------------------------
-- RLS — the seven new tables
--
-- ⚠️ A TENANT TABLE WITHOUT A POLICY PRODUCES NO ERROR AND BREAKS NO
--   SINGLE-TENANT TEST. It just starts returning other clinics' records — and
--   the records here are "which medicine was given to which named person".
--   `db:rls:check` fails until these exist, deliberately.
--
-- Both policies, on all seven: the permissive org policy and the RESTRICTIVE
-- branch policy. `branch_id` is NOT NULL on every one of them, so the branch
-- predicate is absolute rather than the `IS NULL OR` shape it takes elsewhere;
-- the wording below is kept identical to `enable-rls.sql` so the two files can
-- be diffed by eye.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  pharmacy_tables text[] := ARRAY[
    'prescription_fulfilments',
    'dispenses',
    'dispense_lines',
    'dispense_allocations',
    'dispense_returns',
    'dispense_return_lines',
    'regulatory_decisions'
  ];
BEGIN
  FOREACH t IN ARRAY pharmacy_tables LOOP
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

    EXECUTE format('DROP POLICY IF EXISTS branch_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY branch_isolation ON %I AS RESTRICTIVE
        USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
        WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
    $f$, t);
  END LOOP;
END
$$;
