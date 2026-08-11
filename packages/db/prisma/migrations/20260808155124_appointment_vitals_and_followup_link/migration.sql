-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "parent_appointment_id" UUID;

-- CreateTable
CREATE TABLE "appointment_vitals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "height_cm" DECIMAL(5,1),
    "weight_kg" DECIMAL(5,1),
    "temperature_c" DECIMAL(4,1),
    "pulse_bpm" SMALLINT,
    "respiratory_rate_bpm" SMALLINT,
    "systolic_mm_hg" SMALLINT,
    "diastolic_mm_hg" SMALLINT,
    "spo2_percent" SMALLINT,
    "blood_glucose_mg_dl" DECIMAL(5,1),
    "notes" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "appointment_vitals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointment_vitals_organization_id_appointment_id_recorded__idx" ON "appointment_vitals"("organization_id", "appointment_id", "recorded_at");

-- CreateIndex
CREATE INDEX "appointment_vitals_organization_id_patient_id_recorded_at_idx" ON "appointment_vitals"("organization_id", "patient_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_vitals_organization_id_id_key" ON "appointment_vitals"("organization_id", "id");

-- CreateIndex
CREATE INDEX "appointments_organization_id_parent_appointment_id_idx" ON "appointments"("organization_id", "parent_appointment_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_parent_appointment_id_fkey" FOREIGN KEY ("organization_id", "parent_appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_vitals" ADD CONSTRAINT "appointment_vitals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_vitals" ADD CONSTRAINT "appointment_vitals_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_vitals" ADD CONSTRAINT "appointment_vitals_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_vitals" ADD CONSTRAINT "appointment_vitals_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_vitals" ADD CONSTRAINT "appointment_vitals_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Row-Level Security — copied from packages/db/prisma/rls/enable-rls.sql.
--
-- ⚠️ PHI, AND THE MOST MECHANICALLY SENSITIVE KIND. A blood pressure, a blood
--   glucose and a temperature against a named patient are a clinical record on
--   their own — no interpretation needed, no join required. A missing policy
--   here raises no error, breaks no single-tenant test, and starts handing one
--   clinic another clinic's observations.
--
-- ⚠️ ORG-SCOPED **AND** BRANCH-SCOPED, the same call as `appointments`. Vitals
--   are taken at a place, so they follow attendance rather than identity. The
--   service copies branch_id off the appointment; it is never taken from the
--   caller. See ADR-0016.
--
-- Unlike `appointment_status_history`, this table carries both organization_id
-- and branch_id of its own, so it is an ordinary member of both shared loops in
-- enable-rls.sql rather than a hand-written parent predicate that has to restate
-- the branch test and can drift from it.
-- =============================================================================

DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'appointment_vitals'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
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

-- branch_id is NOT NULL here, so the policy is absolute. The `IS NULL OR` limb
-- is dead code and kept anyway, so this is character-for-character the policy
-- the shared `branch_scoped` loop in enable-rls.sql writes — two spellings of
-- one policy is how the source of truth stops being one.
DROP POLICY IF EXISTS branch_isolation ON appointment_vitals;
CREATE POLICY branch_isolation ON appointment_vitals AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));
