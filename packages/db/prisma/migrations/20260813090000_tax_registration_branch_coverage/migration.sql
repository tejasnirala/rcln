-- Coverage becomes a statement, and a registration stops being one-per-place.
--
-- Two changes, one idea. `issuer_tax_registration_branches` lets a clinic SAY
-- which branches a registration covers, where before the answer was inferred
-- from matching region codes. And the registration's own unique key moves from
-- the jurisdiction to the NUMBER, which is what makes a second registration in
-- one state, and a lapsed one kept beside its replacement, recordable at all.
--
-- Everything below `-- HAND-WRITTEN` is SQL Prisma Migrate cannot generate: the
-- backfill that turns today's inferred coverage into stated coverage, and the
-- RLS policy without which one clinic reads another's.

-- DropIndex
--
-- (organization, country, region, scheme). It read as "one registration per
-- place" and forbade two true things: a second concurrent registration in one
-- jurisdiction, and keeping a lapsed registration alongside the one that
-- replaced it. Replaced below by a key on the number.
DROP INDEX "issuer_tax_registrations_organization_id_country_code_regio_key";

-- CreateTable
CREATE TABLE "issuer_tax_registration_branches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tax_registration_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "issuer_tax_registration_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issuer_tax_registration_branches_organization_id_branch_id_idx" ON "issuer_tax_registration_branches"("organization_id", "branch_id");

-- CreateIndex
CREATE INDEX "issuer_tax_registration_branches_organization_id_tax_regist_idx" ON "issuer_tax_registration_branches"("organization_id", "tax_registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_tax_registration_branches_organization_id_tax_regist_key" ON "issuer_tax_registration_branches"("organization_id", "tax_registration_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_tax_registrations_organization_id_country_code_schem_key" ON "issuer_tax_registrations"("organization_id", "country_code", "scheme", "registration_number");

-- AddForeignKey
ALTER TABLE "issuer_tax_registration_branches" ADD CONSTRAINT "issuer_tax_registration_branches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issuer_tax_registration_branches" ADD CONSTRAINT "issuer_tax_registration_branches_organization_id_tax_regis_fkey" FOREIGN KEY ("organization_id", "tax_registration_id") REFERENCES "issuer_tax_registrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issuer_tax_registration_branches" ADD CONSTRAINT "issuer_tax_registration_branches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Turn the coverage the engine has been INFERRING into coverage the clinic has
-- STATED.
--
-- Every existing registration already covers, in effect, the branches whose
-- (country, region) it matches — that match is how `registrationFor` has been
-- selecting all along. Writing those pairs down changes no invoice and no
-- behaviour; it just means the answer is now a row somebody can see and edit
-- rather than a coincidence of two address fields.
--
-- ⚠️ THE MATCH IS THE ENGINE'S, NOT A NEW ONE. A registration with no region
--   is country-wide and covers every branch in that country; one with a region
--   covers only the branches in it. Anything looser here would hand a clinic
--   coverage it never had and change what prints on its next invoice.
--
-- Soft-deleted rows on either side are skipped: a link to a retired branch is
-- not a fact worth stating, and it would reappear in the coverage editor.
-- ---------------------------------------------------------------------------
INSERT INTO "issuer_tax_registration_branches"
  ("id", "organization_id", "tax_registration_id", "branch_id", "created_at", "updated_at")
SELECT gen_random_uuid(),
       r."organization_id",
       r."id",
       b."id",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM "issuer_tax_registrations" r
  JOIN "branches" b
    ON b."organization_id" = r."organization_id"
   AND b."country_code"    = r."country_code"
   AND (r."region_code" IS NULL OR b."region_code" = r."region_code")
 WHERE r."deleted_at" IS NULL
   AND b."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS. The rows are the tenant's own, exactly like the two tables they join.
--
-- ⚠️ A LINK TABLE IS NOT EXEMPT JUST BECAUSE IT HOLDS ONLY IDS. Both ids are
--   tenant ids, and reading another organization's row tells you which of its
--   branches bills under which of its registrations — the same leak as reading
--   the registration itself, one join later.
--
-- Kept identical to prisma/rls/enable-rls.sql, which is the file db:rls:check
-- reads. Both must change together or the check passes on a database that has
-- drifted from the source.
-- ---------------------------------------------------------------------------
ALTER TABLE "issuer_tax_registration_branches" ENABLE   ROW LEVEL SECURITY;
-- Explicit: the owner must keep bypassing, so migrations and seeds work.
ALTER TABLE "issuer_tax_registration_branches" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "issuer_tax_registration_branches";
CREATE POLICY tenant_isolation ON "issuer_tax_registration_branches"
  USING ("organization_id" = app_current_org())
  WITH CHECK ("organization_id" = app_current_org());
