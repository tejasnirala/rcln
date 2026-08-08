-- CreateEnum
CREATE TYPE "DoctorStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ScheduleExceptionType" AS ENUM ('LEAVE', 'BLOCK', 'EXTRA_SHIFT');

-- CreateEnum
CREATE TYPE "ScheduleExceptionStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "specialties" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "parent_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registration_number" VARCHAR(64),
    "registration_council" VARCHAR(255),
    "registration_valid_till" DATE,
    "experience_years" SMALLINT,
    "bio" TEXT,
    "signature_file_id" UUID,
    "status" "DoctorStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_specialties" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_profile_id" UUID NOT NULL,
    "specialty_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_qualifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_profile_id" UUID NOT NULL,
    "qualification_id" UUID NOT NULL,
    "institute" VARCHAR(255),
    "year_of_completion" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_branch_settings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_profile_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "consultation_fee" DECIMAL(14,2),
    "follow_up_fee" DECIMAL(14,2),
    "follow_up_free_days" SMALLINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "doctor_branch_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_schedules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_profile_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "slot_minutes" SMALLINT,
    "max_patients" SMALLINT,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "doctor_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_schedule_exceptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "doctor_profile_id" UUID NOT NULL,
    "branch_id" UUID,
    "exception_type" "ScheduleExceptionType" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" VARCHAR(255),
    "status" "ScheduleExceptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "doctor_schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "specialties_organization_id_is_active_idx" ON "specialties"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "specialties_organization_id_code_key" ON "specialties"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "qualifications_organization_id_code_key" ON "qualifications"("organization_id", "code");

-- CreateIndex
CREATE INDEX "doctor_profiles_organization_id_status_idx" ON "doctor_profiles"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_organization_id_user_id_key" ON "doctor_profiles"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_organization_id_id_key" ON "doctor_profiles"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_organization_id_registration_number_key" ON "doctor_profiles"("organization_id", "registration_number");

-- CreateIndex
CREATE INDEX "doctor_specialties_organization_id_specialty_id_idx" ON "doctor_specialties"("organization_id", "specialty_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_specialties_organization_id_doctor_profile_id_specia_key" ON "doctor_specialties"("organization_id", "doctor_profile_id", "specialty_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_qualifications_organization_id_doctor_profile_id_qua_key" ON "doctor_qualifications"("organization_id", "doctor_profile_id", "qualification_id", "institute");

-- CreateIndex
CREATE INDEX "doctor_branch_settings_organization_id_branch_id_is_active_idx" ON "doctor_branch_settings"("organization_id", "branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_branch_settings_organization_id_doctor_profile_id_br_key" ON "doctor_branch_settings"("organization_id", "doctor_profile_id", "branch_id");

-- CreateIndex
CREATE INDEX "doctor_schedules_organization_id_branch_id_day_of_week_idx" ON "doctor_schedules"("organization_id", "branch_id", "day_of_week");

-- CreateIndex
CREATE INDEX "doctor_schedules_doctor_profile_id_day_of_week_idx" ON "doctor_schedules"("doctor_profile_id", "day_of_week");

-- CreateIndex
CREATE INDEX "doctor_schedule_exceptions_organization_id_doctor_profile_i_idx" ON "doctor_schedule_exceptions"("organization_id", "doctor_profile_id", "starts_at");

-- CreateIndex
CREATE INDEX "doctor_schedule_exceptions_organization_id_status_starts_at_idx" ON "doctor_schedule_exceptions"("organization_id", "status", "starts_at");

-- AddForeignKey
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "specialties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_specialties" ADD CONSTRAINT "doctor_specialties_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_specialties" ADD CONSTRAINT "doctor_specialties_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_specialties" ADD CONSTRAINT "doctor_specialties_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_qualifications" ADD CONSTRAINT "doctor_qualifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_qualifications" ADD CONSTRAINT "doctor_qualifications_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_qualifications" ADD CONSTRAINT "doctor_qualifications_qualification_id_fkey" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_branch_settings" ADD CONSTRAINT "doctor_branch_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_branch_settings" ADD CONSTRAINT "doctor_branch_settings_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_branch_settings" ADD CONSTRAINT "doctor_branch_settings_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedule_exceptions" ADD CONSTRAINT "doctor_schedule_exceptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedule_exceptions" ADD CONSTRAINT "doctor_schedule_exceptions_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "doctor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedule_exceptions" ADD CONSTRAINT "doctor_schedule_exceptions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written from here down. Prisma Migrate generates none of it and will
-- happily DROP any of it on the next schema change — review future generated
-- migrations for DROP INDEX / DROP CONSTRAINT naming anything below.
-- =============================================================================

-- --- Extensions ---------------------------------------------------------------
-- ⚠️ HERE, not only in infra/postgres/init/01-roles-and-extensions.sql.
--
-- Extensions are PER-DATABASE. The init script creates btree_gist against
-- POSTGRES_DB only, but `prisma migrate dev` replays every migration into a
-- FRESH SHADOW DATABASE that has never seen it — so the EXCLUDE below fails
-- there with `data type uuid has no default operator class for access method
-- "gist"`, and the symptom is "migrations work in dev but migrate dev is
-- broken". btree_gist is a TRUSTED extension in PG13+, so rcln_owner can create
-- it without superuser.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- --- Null-safe uniques --------------------------------------------------------
-- A plain unique index does not constrain nullable columns, so each of these is
-- a hole exactly where it matters most.

-- Platform rows carry organization_id NULL; without this they are not unique
-- among themselves and 'CARDIO' could be seeded twice.
DROP INDEX IF EXISTS "specialties_organization_id_code_key";
CREATE UNIQUE INDEX "specialties_organization_id_code_key"
  ON "specialties" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX IF EXISTS "qualifications_organization_id_code_key";
CREATE UNIQUE INDEX "qualifications_organization_id_code_key"
  ON "qualifications" ("organization_id", "code") NULLS NOT DISTINCT;

-- registration_number is nullable (a profile can be created before the council
-- number is to hand), but two doctors sharing one is a data-entry error.
DROP INDEX IF EXISTS "doctor_profiles_organization_id_registration_number_key";
CREATE UNIQUE INDEX "doctor_profiles_organization_id_registration_number_key"
  ON "doctor_profiles" ("organization_id", "registration_number") NULLS NOT DISTINCT;

-- institute is nullable, and "MD, institute unknown" must not be recordable twice.
DROP INDEX IF EXISTS "doctor_qualifications_organization_id_doctor_profile_id_qua_key";
CREATE UNIQUE INDEX "doctor_qualifications_organization_id_doctor_profile_id_qua_key"
  ON "doctor_qualifications"
     ("organization_id", "doctor_profile_id", "qualification_id", "institute")
  NULLS NOT DISTINCT;

-- --- Exactly one primary specialty per doctor ---------------------------------
-- Prisma cannot express a partial unique index. Without it a doctor can have
-- three "primary" specialties and the profile header picks one arbitrarily.
CREATE UNIQUE INDEX "doctor_specialties_one_primary"
  ON "doctor_specialties" ("doctor_profile_id") WHERE "is_primary";

-- --- CHECK constraints --------------------------------------------------------
ALTER TABLE "specialties"
  ADD CONSTRAINT "specialties_not_own_parent" CHECK ("parent_id" IS DISTINCT FROM "id");

ALTER TABLE "doctor_schedules"
  ADD CONSTRAINT "doctor_schedules_day_of_week_range"
    CHECK ("day_of_week" BETWEEN 0 AND 6),
  -- An overnight block would produce an inverted range that tstzrange refuses
  -- at insert time, deep inside the availability engine. An overnight OPD is
  -- two rows; refuse it here where the error can name the field.
  ADD CONSTRAINT "doctor_schedules_end_after_start"
    CHECK ("end_time" > "start_time"),
  ADD CONSTRAINT "doctor_schedules_valid_range"
    CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- A 0 or negative slot length is an infinite loop in the slot generator; a
  -- 4-hour one is a typo. Both are cheaper to refuse than to debug.
  ADD CONSTRAINT "doctor_schedules_slot_minutes_sane"
    CHECK ("slot_minutes" IS NULL OR "slot_minutes" BETWEEN 5 AND 240),
  ADD CONSTRAINT "doctor_schedules_max_patients_positive"
    CHECK ("max_patients" IS NULL OR "max_patients" > 0);

ALTER TABLE "doctor_schedule_exceptions"
  ADD CONSTRAINT "doctor_schedule_exceptions_end_after_start"
    CHECK ("ends_at" > "starts_at");

ALTER TABLE "doctor_branch_settings"
  ADD CONSTRAINT "doctor_branch_settings_fees_non_negative"
    CHECK (("consultation_fee" IS NULL OR "consultation_fee" >= 0)
       AND ("follow_up_fee"    IS NULL OR "follow_up_fee"    >= 0));

-- --- No overlapping working hours ---------------------------------------------
-- Two blocks a day (morning and evening) is normal, so there is no natural
-- unique key to lean on — but the SAME doctor listed 09:00-13:00 and 12:00-17:00
-- at one branch makes the availability engine generate overlapping slots, and
-- the appointment EXCLUDE constraint then rejects the second booking with an
-- error nobody can trace back to a schedule typo.
--
-- Times are compared as minutes-since-midnight because GiST has no range type
-- for `time`. Validity windows overlap as a daterange, so re-using a slot after
-- an old schedule expires is allowed. Inactive rows are exempt.
ALTER TABLE "doctor_schedules"
  ADD CONSTRAINT "doctor_schedules_no_overlap"
  EXCLUDE USING gist (
    "organization_id"   WITH =,
    "doctor_profile_id" WITH =,
    "branch_id"         WITH =,
    "day_of_week"       WITH =,
    daterange("valid_from", COALESCE("valid_to", 'infinity'::date), '[]') WITH &&,
    int4range(
      (EXTRACT(hour FROM "start_time") * 60 + EXTRACT(minute FROM "start_time"))::int,
      (EXTRACT(hour FROM "end_time")   * 60 + EXTRACT(minute FROM "end_time"))::int,
      '[)'
    ) WITH &&
  ) WHERE ("is_active");

-- --- Row-level security -------------------------------------------------------
-- Verbatim from prisma/rls/enable-rls.sql, restricted to the new tables.
DO $$
DECLARE
  t text;
  org_scoped text[] := ARRAY[
    'doctor_profiles',
    'doctor_specialties',
    'doctor_qualifications',
    'doctor_branch_settings',
    'doctor_schedules',
    'doctor_schedule_exceptions'
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

-- Platform catalogue + per-tenant extension.
-- ⚠️ READ IS PERMISSIVE, WRITE IS NOT — this is NOT the `files` policy. A
-- NULL-permissive WITH CHECK would let any clinic insert a platform-wide
-- specialty visible to every other tenant. See enable-rls.sql.
DO $$
DECLARE
  t text;
  platform_extensible text[] := ARRAY[
    'specialties',
    'qualifications'
  ];
BEGIN
  FOREACH t IN ARRAY platform_extensible LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (organization_id IS NULL OR organization_id = app_current_org())
        WITH CHECK (organization_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

-- Branch scoping on working hours. branch_id is NOT NULL here, so a
-- branch-scoped reader seeing only its own branch is correct. Contrast
-- doctor_schedule_exceptions, deliberately absent: branch_id NULL there means
-- "every branch", and hiding a doctor's leave would produce phantom
-- availability rather than a restriction.
DROP POLICY IF EXISTS branch_isolation ON doctor_schedules;
CREATE POLICY branch_isolation ON doctor_schedules AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));

-- The second parent of each join table. `specialty_id` is a plain FK because a
-- specialty may be a platform row with no organization_id to compose with, so
-- tenant_isolation constrains the DOCTOR side and says nothing about the
-- SPECIALTY side. Same shape as `branch_in_same_org` on invitation_branches.
DROP POLICY IF EXISTS specialty_visible ON doctor_specialties;
CREATE POLICY specialty_visible ON doctor_specialties AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM specialties s
    WHERE s.id = doctor_specialties.specialty_id
      AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM specialties s
    WHERE s.id = doctor_specialties.specialty_id
      AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS qualification_visible ON doctor_qualifications;
CREATE POLICY qualification_visible ON doctor_qualifications AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM qualifications q
    WHERE q.id = doctor_qualifications.qualification_id
      AND (q.organization_id IS NULL OR q.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM qualifications q
    WHERE q.id = doctor_qualifications.qualification_id
      AND (q.organization_id IS NULL OR q.organization_id = app_current_org())
  ));
