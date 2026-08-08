-- CreateEnum
CREATE TYPE "DataAccessType" AS ENUM ('VIEW', 'SEARCH', 'PRINT', 'EXPORT', 'SHARE');

-- CreateEnum
CREATE TYPE "DataAccessResource" AS ENUM ('PATIENT', 'PATIENT_LIST', 'MEDICAL_HISTORY', 'APPOINTMENT', 'PRESCRIPTION', 'LAB_REPORT', 'INVOICE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "NumberSequenceType" AS ENUM ('UHID', 'MRN', 'APPOINTMENT', 'QUEUE_TOKEN');

-- CreateTable
CREATE TABLE "data_access_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "actor_user_id" UUID,
    "impersonated_by_user_id" UUID,
    "patient_id" UUID,
    "access_type" "DataAccessType" NOT NULL,
    "resource" "DataAccessResource" NOT NULL,
    "resource_id" UUID,
    "result_count" INTEGER NOT NULL DEFAULT 1,
    "query_hash" CHAR(64),
    "route" VARCHAR(128),
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "sequence_type" "NumberSequenceType" NOT NULL,
    "period_key" VARCHAR(64) NOT NULL DEFAULT '',
    "prefix" VARCHAR(16) NOT NULL DEFAULT '',
    "padding" SMALLINT NOT NULL DEFAULT 6,
    "last_number" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_access_logs_organization_id_patient_id_occurred_at_idx" ON "data_access_logs"("organization_id", "patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "data_access_logs_organization_id_actor_user_id_occurred_at_idx" ON "data_access_logs"("organization_id", "actor_user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_organization_id_branch_id_sequence_type_pe_key" ON "number_sequences"("organization_id", "branch_id", "sequence_type", "period_key");

-- AddForeignKey
ALTER TABLE "data_access_logs" ADD CONSTRAINT "data_access_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_access_logs" ADD CONSTRAINT "data_access_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Everything below is hand-written: Prisma Migrate does not generate RLS
-- policies, NULLS NOT DISTINCT indexes, grants or triggers, and will happily
-- generate a migration that DROPS them on the next schema change. Review future
-- generated migrations for DROP INDEX / DROP CONSTRAINT naming anything here.
-- =============================================================================

-- --- number_sequences: the unique must actually constrain the null branch ----
--
-- `branch_id` is NULL on every org-wide counter (UHID). A plain unique index
-- does not constrain nullable columns, so two UHID counters for one clinic could
-- coexist and hand out the same number twice. This index is ALSO the arbiter for
-- the `ON CONFLICT (organization_id, branch_id, sequence_type, period_key)`
-- clause in issueNumber() — ON CONFLICT requires an index that matches, so
-- without NULLS NOT DISTINCT the UHID path raises instead of incrementing.
DROP INDEX IF EXISTS "number_sequences_organization_id_branch_id_sequence_type_pe_key";

CREATE UNIQUE INDEX "number_sequences_organization_id_branch_id_sequence_type_pe_key"
  ON "number_sequences" ("organization_id", "branch_id", "sequence_type", "period_key")
  NULLS NOT DISTINCT;

-- --- Row-level security -------------------------------------------------------
-- Verbatim from prisma/rls/enable-rls.sql, restricted to the new tables.
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'data_access_logs',
    'number_sequences'
  ];
BEGIN
  FOREACH t IN ARRAY org_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- Explicit: the owner must keep bypassing, so migrations and seeds work.
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

-- NOTE: number_sequences deliberately gets NO branch_isolation policy, even
-- though it carries a branch_id. `ON CONFLICT DO UPDATE` against a row that RLS
-- hides does not update that row — it raises 23505 unique_violation — so a
-- branch-scoped policy would turn "that branch is outside your scope" into a
-- baffling duplicate-key error at the moment of booking. Isolation here is the
-- tenant policy plus the explicit organization_id every call passes.
