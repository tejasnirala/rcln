-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'WIDOWED', 'DIVORCED', 'SEPARATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PatientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DECEASED', 'MERGED');

-- CreateEnum
CREATE TYPE "PatientRegistrationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('HOME', 'WORK', 'OTHER');

-- CreateEnum
CREATE TYPE "AllergenType" AS ENUM ('DRUG', 'FOOD', 'ENVIRONMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');

-- CreateEnum
-- Declaration order is load-bearing: it IS the sort order, and the problem list
-- is read `status ASC` so an active or chronic problem is never below a
-- resolved one.
CREATE TYPE "PatientConditionStatus" AS ENUM ('ACTIVE', 'CHRONIC', 'RESOLVED');

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "uhid" VARCHAR(32) NOT NULL,
    "user_id" UUID,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "date_of_birth" DATE,
    "approx_age_years" SMALLINT,
    "gender" "Gender" NOT NULL DEFAULT 'UNKNOWN',
    "blood_group" "BloodGroup" NOT NULL DEFAULT 'UNKNOWN',
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "abha_number" VARCHAR(32),
    "national_id" VARCHAR(64),
    "marital_status" "MaritalStatus" NOT NULL DEFAULT 'UNKNOWN',
    "status" "PatientStatus" NOT NULL DEFAULT 'ACTIVE',
    "deceased_on" DATE,
    "merged_into_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_registrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "mrn" VARCHAR(32) NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_by" UUID,
    "status" "PatientRegistrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_addresses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "address_type" "AddressType" NOT NULL DEFAULT 'HOME',
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "country_code" CHAR(2) NOT NULL DEFAULT 'IN',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_contacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "relation" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "is_guardian" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "allergen_type" "AllergenType" NOT NULL DEFAULT 'DRUG',
    "allergen_text" VARCHAR(255) NOT NULL,
    "severity" "AllergySeverity" NOT NULL DEFAULT 'MODERATE',
    "reaction" VARCHAR(255),
    "noted_on" DATE,
    "noted_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_conditions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "condition_text" VARCHAR(255) NOT NULL,
    "status" "PatientConditionStatus" NOT NULL DEFAULT 'ACTIVE',
    "onset_date" DATE,
    "resolved_date" DATE,
    "note" TEXT,
    "noted_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_medications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "medicine_text" VARCHAR(255) NOT NULL,
    "dosage" VARCHAR(255),
    "started_on" DATE,
    "stopped_on" DATE,
    "is_ongoing" BOOLEAN NOT NULL DEFAULT true,
    "noted_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patient_medications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patients_organization_id_phone_idx" ON "patients"("organization_id", "phone");

-- CreateIndex
CREATE INDEX "patients_organization_id_status_idx" ON "patients"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "patients_organization_id_uhid_key" ON "patients"("organization_id", "uhid");

-- CreateIndex
CREATE UNIQUE INDEX "patients_organization_id_id_key" ON "patients"("organization_id", "id");

-- CreateIndex
CREATE INDEX "patient_registrations_organization_id_branch_id_status_idx" ON "patient_registrations"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "patient_registrations_organization_id_patient_id_branch_id_key" ON "patient_registrations"("organization_id", "patient_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_registrations_organization_id_branch_id_mrn_key" ON "patient_registrations"("organization_id", "branch_id", "mrn");

-- CreateIndex
CREATE UNIQUE INDEX "patient_registrations_organization_id_id_key" ON "patient_registrations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "patient_addresses_organization_id_patient_id_idx" ON "patient_addresses"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_contacts_organization_id_patient_id_idx" ON "patient_contacts"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_allergies_organization_id_patient_id_idx" ON "patient_allergies"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_conditions_organization_id_patient_id_idx" ON "patient_conditions"("organization_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_medications_organization_id_patient_id_idx" ON "patient_medications"("organization_id", "patient_id");

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_organization_id_merged_into_id_fkey" FOREIGN KEY ("organization_id", "merged_into_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registrations" ADD CONSTRAINT "patient_registrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registrations" ADD CONSTRAINT "patient_registrations_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registrations" ADD CONSTRAINT "patient_registrations_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_registrations" ADD CONSTRAINT "patient_registrations_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_addresses" ADD CONSTRAINT "patient_addresses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_addresses" ADD CONSTRAINT "patient_addresses_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_conditions" ADD CONSTRAINT "patient_conditions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_conditions" ADD CONSTRAINT "patient_conditions_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_conditions" ADD CONSTRAINT "patient_conditions_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_medications" ADD CONSTRAINT "patient_medications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_medications" ADD CONSTRAINT "patient_medications_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_medications" ADD CONSTRAINT "patient_medications_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written from here down. Prisma Migrate generates none of it and will
-- happily DROP any of it on the next schema change — review future generated
-- migrations for DROP INDEX / DROP POLICY naming anything below.
-- =============================================================================

-- --- Extensions ---------------------------------------------------------------
-- ⚠️ HERE, not only in infra/postgres/init/01-roles-and-extensions.sql.
--
-- Extensions are PER-DATABASE. The init script creates pg_trgm against
-- POSTGRES_DB only, but `prisma migrate dev` replays every migration into a
-- FRESH SHADOW DATABASE that has never seen it — so the GIN index below fails
-- there with `operator class "gin_trgm_ops" does not exist`, and the symptom is
-- "migrations work in dev but migrate dev is broken". Same trap as btree_gist
-- in the doctors migration. pg_trgm is TRUSTED in PG13+, so rcln_owner can
-- create it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --- Patient name search ------------------------------------------------------
-- The front desk types three letters of a surname. Without a trigram index that
-- is a sequential scan over `patients` — and note what RLS does and does not do
-- here: the tenant predicate is applied AFTER the scan, so the cost grows with
-- the number of patients on the PLATFORM, not with the tenant's own. The first
-- clinic to notice is the smallest one.
--
-- An expression index, which Prisma cannot express: the search is against the
-- full name as one string, so `first_name || ' ' || last_name` must be indexed
-- rather than the two columns separately. `coalesce` because last_name is
-- nullable and `'Asha' || NULL` is NULL, which would index nothing at all.
CREATE INDEX patients_name_trgm_idx
  ON patients
  USING gin ((lower(first_name || ' ' || coalesce(last_name, ''))) gin_trgm_ops);

-- Phone is searched by prefix and by fragment ("the number ending 4417"), so it
-- gets a trigram index too rather than a btree.
CREATE INDEX patients_phone_trgm_idx
  ON patients
  USING gin (phone gin_trgm_ops);

-- --- Null-safe uniques --------------------------------------------------------
-- A plain unique index does not constrain nullable columns.
--
-- ABHA and the national id identify a human being to a government. The same
-- number appearing on two records in one clinic is the duplicate this whole
-- registration flow exists to prevent, and it is worth refusing at the database
-- rather than warning about in a service. NULLS NOT DISTINCT is deliberately
-- NOT used: most patients have neither number, and treating a hundred NULLs as
-- collisions would refuse every registration after the first.
CREATE UNIQUE INDEX patients_org_abha_key
  ON patients (organization_id, abha_number)
  WHERE abha_number IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX patients_org_national_id_key
  ON patients (organization_id, national_id)
  WHERE national_id IS NOT NULL AND deleted_at IS NULL;

-- --- CHECK constraints --------------------------------------------------------
-- Age is recorded as a birth date OR an approximate year count, never both:
-- two sources for one number is how a paediatric dose gets computed from the
-- stale one. Neither is also legal — an unconscious admission has no age.
ALTER TABLE patients
  ADD CONSTRAINT patients_age_single_source
  CHECK (date_of_birth IS NULL OR approx_age_years IS NULL);

-- A merge must name a survivor, and only a merge may name one. Without this,
-- `merged_into_id` can be set on an ACTIVE record, and every read that follows
-- the pointer silently returns someone else's chart.
ALTER TABLE patients
  ADD CONSTRAINT patients_merge_target_matches_status
  CHECK ((status = 'MERGED') = (merged_into_id IS NOT NULL));

-- A record cannot be merged into itself: that is an infinite loop in every
-- resolver that follows the chain.
ALTER TABLE patients
  ADD CONSTRAINT patients_merge_not_self
  CHECK (merged_into_id IS NULL OR merged_into_id <> id);

-- A condition cannot resolve before it began.
ALTER TABLE patient_conditions
  ADD CONSTRAINT patient_conditions_dates_ordered
  CHECK (onset_date IS NULL OR resolved_date IS NULL OR resolved_date >= onset_date);

ALTER TABLE patient_medications
  ADD CONSTRAINT patient_medications_dates_ordered
  CHECK (started_on IS NULL OR stopped_on IS NULL OR stopped_on >= started_on);

-- Still taking it, and stopped on a date, are contradictory answers.
ALTER TABLE patient_medications
  ADD CONSTRAINT patient_medications_ongoing_has_no_stop
  CHECK (NOT (is_ongoing AND stopped_on IS NOT NULL));

-- =============================================================================
-- Row-Level Security — copied from packages/db/prisma/rls/enable-rls.sql.
--
-- ⚠️ SEVEN NEW TABLES OF PHI. A missing policy here raises no error, breaks no
-- single-tenant test, and starts returning other clinics' patient records.
-- `pnpm db:rls:check` is the thing that notices.
--
-- ⚠️ `patients` IS ORG-SCOPED ONLY, WITH NO branch_isolation, DELIBERATELY.
--   A person is one person across a hospital group. Their allergy list must
--   follow them into whichever branch they walk into, and — more sharply — a
--   front desk that cannot see head office already registered them will
--   register them again. Two UHIDs for one human being is a clinical safety
--   failure, because the second record has no allergies on it.
--
--   The branch boundary belongs on `patient_registrations`, which is the row
--   that answers "does this person attend our clinic?", and that is where it
--   is. See ADR-0016.
-- =============================================================================

DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'patients',
    'patient_registrations',
    'patient_addresses',
    'patient_contacts',
    'patient_allergies',
    'patient_conditions',
    'patient_medications'
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

-- branch_id is NOT NULL on this table, so the policy is absolute: a
-- receptionist scoped to one branch cannot read another branch's registration
-- list, nor its MRN series. RESTRICTIVE so it ANDs with tenant_isolation.
--
-- The `IS NULL OR` limb is dead code here and kept anyway, so this policy is
-- character-for-character the one the shared `branch_scoped` loop in
-- enable-rls.sql writes. Two spellings of one policy is how the file that is
-- supposed to be the source of truth stops being it.
DROP POLICY IF EXISTS branch_isolation ON patient_registrations;
CREATE POLICY branch_isolation ON patient_registrations AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));
