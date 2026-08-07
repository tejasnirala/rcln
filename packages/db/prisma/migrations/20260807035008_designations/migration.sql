/*
  Warnings:

  - You are about to drop the column `designation` on the `staff_profiles` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "NumberSequenceType" ADD VALUE 'EMPLOYEE';

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "designation_id" UUID;

-- AlterTable
ALTER TABLE "staff_profiles" DROP COLUMN "designation",
ADD COLUMN     "designation_id" UUID;

-- CreateTable
CREATE TABLE "designations" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "designations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "designations_organization_id_is_active_idx" ON "designations"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "designations_organization_id_code_key" ON "designations"("organization_id", "code");

-- CreateIndex
CREATE INDEX "staff_profiles_designation_id_idx" ON "staff_profiles"("designation_id");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designations" ADD CONSTRAINT "designations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_designation_id_fkey" FOREIGN KEY ("designation_id") REFERENCES "designations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Hand-written from here down. Prisma Migrate generates none of it.
--
-- NOTE on the dropped column: `staff_profiles.designation` was free text and had
-- ZERO rows, so this is a clean swap rather than a data migration. It is
-- replaced by designation_id because a job title is a closed set the clinic
-- curates — free text produces "Sr. Consultant", "Senior Consultant" and
-- "Sr Consultant" as three different things.
-- =============================================================================

-- Platform rows carry organization_id NULL; a plain unique index does not
-- constrain nullable columns, so without this 'CONSULTANT' could be seeded twice.
DROP INDEX IF EXISTS "designations_organization_id_code_key";
CREATE UNIQUE INDEX "designations_organization_id_code_key"
  ON "designations" ("organization_id", "code") NULLS NOT DISTINCT;

-- Platform catalogue + per-tenant extension.
-- ⚠️ READ IS PERMISSIVE, WRITE IS NOT — this is NOT the `files` policy. A
-- NULL-permissive WITH CHECK would let any clinic insert a platform-wide
-- designation visible to every other tenant. Same shape as `specialties`,
-- and the tenant-isolation suite measures it.
ALTER TABLE designations ENABLE   ROW LEVEL SECURITY;
ALTER TABLE designations NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON designations;
CREATE POLICY tenant_isolation ON designations
  USING      (organization_id IS NULL OR organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

-- The second parent of two tables that already carry their own isolation.
--
-- `invitations.designation_id` and `staff_profiles.designation_id` are plain FKs,
-- because a designation may be a platform row with no organization_id to compose
-- with. Their own policies constrain the invitation/membership side and say
-- nothing about the designation side, so without these a clinic could attach
-- another clinic's private designation and read its name back out.
--
-- Same shape as `branch_in_same_org` on invitation_branches.
DROP POLICY IF EXISTS designation_visible ON invitations;
CREATE POLICY designation_visible ON invitations AS RESTRICTIVE
  USING (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = invitations.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ))
  WITH CHECK (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = invitations.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ));

-- staff_profiles has no organization_id; it is isolated by parent_isolation
-- against its membership. That constrains the MEMBERSHIP side and says nothing
-- about the designation, so the same RESTRICTIVE guard applies here.
DROP POLICY IF EXISTS designation_visible ON staff_profiles;
CREATE POLICY designation_visible ON staff_profiles AS RESTRICTIVE
  USING (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = staff_profiles.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ))
  WITH CHECK (designation_id IS NULL OR EXISTS (
    SELECT 1 FROM designations d
    WHERE d.id = staff_profiles.designation_id
      AND (d.organization_id IS NULL OR d.organization_id = app_current_org())
  ));
