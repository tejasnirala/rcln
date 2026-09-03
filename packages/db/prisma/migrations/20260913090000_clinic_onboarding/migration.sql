-- ---------------------------------------------------------------------------
-- CO-1 — the clinic profile and the seven-step wizard (ADR-0018)
--
-- ⚠️ THREE THINGS IN THIS FILE ARE HAND-WRITTEN AND PRISMA MIGRATE CANNOT
--   PRODUCE ANY OF THEM. Do not regenerate this migration and expect it to be
--   equivalent:
--
--     1. The `organizations.onboarded_at` -> `registered_at` RENAME. Prisma
--        emits DROP COLUMN + ADD COLUMN for a field rename, which discards
--        every existing value. The generated pair is replaced below by an
--        ALTER ... RENAME COLUMN.
--     2. `NULLS NOT DISTINCT` on `clinic_profiles (organization_id, branch_id)`.
--        Postgres treats every NULL as distinct from every other, so the
--        generated unique index permits exactly the rows it exists to forbid —
--        many org-level profiles for one organization.
--     3. The RLS stanzas and the `specialty_visible` RESTRICTIVE policy.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "ClinicModule" AS ENUM ('APPOINTMENTS', 'CONSULTATIONS', 'PHARMACY', 'INVENTORY', 'PROCUREMENT', 'LAB', 'BILLING', 'ONLINE_ORDERS');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('IDENTITY', 'CARE_CONTEXTS', 'MODULES', 'LOCALE_HOURS', 'TAX_BILLING', 'STAFF', 'REVIEW');

-- ---------------------------------------------------------------------------
-- ⚠️ A RENAME, NOT THE GENERATED DROP + ADD.
--
--   `onboarded_at` is stamped by `register.service.ts` inside the registration
--   transaction, so it has always recorded REGISTERED and never "finished
--   setup". Renaming it preserves every clinic's registration timestamp;
--   dropping it would have discarded them, and reusing the column for wizard
--   completion would have read every existing clinic as already onboarded.
--
--   Completion lives on `clinic_profiles.completed_at`, and NO PROFILE ROW IS
--   BACKFILLED — every existing organization correctly reads as not yet
--   onboarded and its owner walks the wizard once, against a form pre-filled
--   from what registration already knows. That is the same code path a brand
--   new clinic takes, so it is exercised by definition.
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" RENAME COLUMN "onboarded_at" TO "registered_at";

-- CreateTable
CREATE TABLE "clinic_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "facility_kind" "BranchType" NOT NULL DEFAULT 'CLINIC',
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinic_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_profile_care_contexts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "branch_id" UUID,
    "specialty_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_profile_care_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_profile_modules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "branch_id" UUID,
    "module" "ClinicModule" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_profile_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_onboarding_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "step" "OnboardingStep" NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinic_onboarding_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clinic_profiles_organization_id_id_key" ON "clinic_profiles"("organization_id", "id");

-- CreateIndex
CREATE INDEX "clinic_profile_care_contexts_organization_id_profile_id_idx" ON "clinic_profile_care_contexts"("organization_id", "profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_profile_care_contexts_organization_id_profile_id_spe_key" ON "clinic_profile_care_contexts"("organization_id", "profile_id", "specialty_id");

-- CreateIndex
CREATE INDEX "clinic_profile_modules_organization_id_profile_id_idx" ON "clinic_profile_modules"("organization_id", "profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_profile_modules_organization_id_profile_id_module_key" ON "clinic_profile_modules"("organization_id", "profile_id", "module");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_onboarding_steps_organization_id_step_key" ON "clinic_onboarding_steps"("organization_id", "step");

-- AddForeignKey
ALTER TABLE "clinic_profiles" ADD CONSTRAINT "clinic_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profiles" ADD CONSTRAINT "clinic_profiles_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profiles" ADD CONSTRAINT "clinic_profiles_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profile_care_contexts" ADD CONSTRAINT "clinic_profile_care_contexts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profile_care_contexts" ADD CONSTRAINT "clinic_profile_care_contexts_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "clinic_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profile_care_contexts" ADD CONSTRAINT "clinic_profile_care_contexts_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profile_modules" ADD CONSTRAINT "clinic_profile_modules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_profile_modules" ADD CONSTRAINT "clinic_profile_modules_organization_id_profile_id_fkey" FOREIGN KEY ("organization_id", "profile_id") REFERENCES "clinic_profiles"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_onboarding_steps" ADD CONSTRAINT "clinic_onboarding_steps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_onboarding_steps" ADD CONSTRAINT "clinic_onboarding_steps_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- ⚠️ NULLS NOT DISTINCT — hand-written, and Prisma cannot express it.
--
--   The org-level profile is the row whose `branch_id` IS NULL. Postgres's
--   default treats every NULL as distinct from every other, so the generated
--   unique index would happily accept a hundred org-level profiles for one
--   organization and "what did this clinic answer" would have no answer —
--   resolution would return whichever row the planner reached first.
--
--   Same rewrite `specialties` needs, for the same reason.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "clinic_profiles_organization_id_branch_id_key"
  ON "clinic_profiles" ("organization_id", "branch_id") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- ⚠️ THE ORG-LEVEL PROFILE IS READ ON EVERY PAGE RENDER — `listMemberships`
--   resolves it beside the branch list on the hottest path in the product.
--   A partial index over exactly that row keeps it a single-page lookup rather
--   than a scan of the organization's branch overrides.
-- ---------------------------------------------------------------------------
CREATE INDEX "clinic_profiles_org_level_idx"
  ON "clinic_profiles" ("organization_id") WHERE "branch_id" IS NULL;

-- ---------------------------------------------------------------------------
-- The org predicate, on all four.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  onboarding_tables text[] := ARRAY[
    'clinic_profiles',
    'clinic_profile_care_contexts',
    'clinic_profile_modules',
    'clinic_onboarding_steps'
  ];
BEGIN
  FOREACH t IN ARRAY onboarding_tables LOOP
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
-- The branch predicate, on the profile and BOTH its children.
--
-- ⚠️ THE `IS NULL OR` HALF IS LIVE HERE, NOT DEAD CODE. NULL means "the
--   organization's answer" and every member must see it; a branch override is
--   visible only to members scoped to that branch. Compare `product_prices`,
--   the other place this half carries weight.
--
-- ⚠️ THE CHILDREN CARRY THEIR OWN `branch_id` RATHER THAN INHERITING ONE
--   THROUGH A PARENT PREDICATE, AND THAT IS THE DELIBERATE CALL OF THIS
--   MIGRATION. Leaving them org-scoped only would have rested on the argument
--   that a module list holds nothing branch-confidential — true today, enforced
--   by nothing tomorrow. An EXISTS against the parent would not have helped
--   either: Postgres evaluates policy expressions with row security DISABLED on
--   the tables they reference, which is why `appointment_status_history`
--   restates its branch predicate by hand instead of leaning on `appointments`.
--
--   ⚠️ WHAT THE DATABASE STILL CANNOT CHECK: that a child's `branch_id` matches
--     its parent's. A composite FK including a nullable column is MATCH SIMPLE,
--     so a child row with `branch_id` NULL skips the check entirely. The
--     service writes both halves in one transaction and the isolation suite
--     asserts they agree. There is no third guard short of a trigger.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  branch_tables text[] := ARRAY[
    'clinic_profiles',
    'clinic_profile_care_contexts',
    'clinic_profile_modules'
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
-- The RESTRICTIVE `specialty_visible` policy — the class `db:rls:check`
-- structurally cannot see.
--
-- `clinic_profile_care_contexts.specialty_id` is a PLAIN FK into `specialties`,
-- which is platform-extensible and therefore allows a NULL `organization_id`.
-- A composite FK cannot be drawn against a nullable-tenant parent, so
-- `tenant_isolation` constrains the CHILD side and says nothing at all about
-- which specialty row the child may name. Without this policy a clinic attaches
-- another clinic's private CARE_CONTEXT node to its own profile and reads its
-- name straight back out of the join that renders the wizard's checkboxes.
--
-- Copied in shape from `doctor_specialties` and `clinical_master_scopes`.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS specialty_visible ON clinic_profile_care_contexts;
CREATE POLICY specialty_visible ON clinic_profile_care_contexts AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM specialties s
    WHERE s.id = clinic_profile_care_contexts.specialty_id
      AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM specialties s
    WHERE s.id = clinic_profile_care_contexts.specialty_id
      AND (s.organization_id IS NULL OR s.organization_id = app_current_org())
  ));
