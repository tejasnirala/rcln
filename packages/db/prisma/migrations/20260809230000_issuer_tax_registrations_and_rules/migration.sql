-- The clinic's own tax position: where it is registered, and what each kind of
-- thing it sells is taxed at.
--
-- Everything below `-- HAND-WRITTEN` is SQL Prisma Migrate cannot generate:
-- NULLS NOT DISTINCT on the two nullable-region unique keys, the CHECK that
-- stops a catalogue row asserting a legal position, the composite FK, the
-- backfill, and the RLS policies. Generated first, appended second, in that
-- order, as ADR-0004 and the RLS gauntlet require.

-- AlterEnum
--
-- Safe inside migrate deploy's transaction because nothing here USES the new
-- value; Postgres only forbids reading a value added in the same transaction.
ALTER TYPE "TaxTreatment" ADD VALUE 'UNRATED';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "country_code" CHAR(2) NOT NULL DEFAULT 'IN',
ADD COLUMN     "region_code" VARCHAR(10);

-- CreateTable
CREATE TABLE "issuer_tax_registrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(10),
    "scheme" "TaxScheme" NOT NULL,
    "registration_number" VARCHAR(64) NOT NULL,
    "legal_name" VARCHAR(255),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "issuer_tax_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(10),
    "scheme" "TaxScheme" NOT NULL,
    "tax_category" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "rate_bps" INTEGER NOT NULL,
    "treatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issuer_tax_registrations_organization_id_country_code_idx" ON "issuer_tax_registrations"("organization_id", "country_code");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_tax_registrations_organization_id_id_key" ON "issuer_tax_registrations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "tax_rules_organization_id_tax_category_effective_from_idx" ON "tax_rules"("organization_id", "tax_category", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rules_organization_id_id_key" ON "tax_rules"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "issuer_tax_registrations" ADD CONSTRAINT "issuer_tax_registrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The two unique keys, with NULLS NOT DISTINCT.
--
-- ⚠️ Prisma emits these as ordinary unique indexes, and an ordinary unique
--   index does NOT constrain rows whose `region_code` is NULL — in SQL two
--   NULLs are never equal, so a clinic could hold five country-wide GSTINs for
--   one scheme and the engine would pick whichever the planner returned first.
--   Country-wide is the COMMON case for the rules table (a GST rate is national
--   even though the registration is per state), so this is not a corner.
--
--   Replaced rather than added alongside, so there is exactly one constraint
--   with the name Prisma expects to find.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "issuer_tax_registrations_organization_id_country_code_regio_key";
CREATE UNIQUE INDEX "issuer_tax_registrations_organization_id_country_code_regio_key"
  ON "issuer_tax_registrations" ("organization_id", "country_code", "region_code", "scheme")
  NULLS NOT DISTINCT;

DROP INDEX IF EXISTS "tax_rules_organization_id_country_code_region_code_scheme_t_key";
CREATE UNIQUE INDEX "tax_rules_organization_id_country_code_region_code_scheme_t_key"
  ON "tax_rules" ("organization_id", "country_code", "region_code", "scheme", "tax_category", "effective_from")
  NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- What an ITEM is allowed to say about itself.
--
-- `TaxTreatment` has six values and a tax rule may only assert three of them.
-- REVERSE_CHARGE is a fact about the two parties to a supply; NOT_REGISTERED
-- and UNRATED are facts about the issuer's own configuration. None of the three
-- is something a consultation or a box of paracetamol can be, and a catalogue
-- row that claimed one would override a legal position it knows nothing about.
--
-- Prisma cannot express a subset of an enum, so it is a CHECK. Mirrored in
-- TypeScript as `ItemTaxTreatment` — the constraint is the one that holds when
-- the row arrives from a seed script or psql instead of through the service.
--
-- The second half is the arithmetic half: a supply that charges nothing must
-- carry a rate of zero. A row saying "EXEMPT at 18%" is not a legal position,
-- it is a data-entry error, and it prints an invoice line that contradicts
-- itself.
-- ---------------------------------------------------------------------------
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_treatment_is_item_level"
  CHECK ("treatment" IN ('STANDARD', 'ZERO_RATED', 'EXEMPT'));

ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_untaxed_means_zero_rate"
  CHECK ("treatment" = 'STANDARD' OR "rate_bps" = 0);

ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_rate_in_range"
  CHECK ("rate_bps" >= 0 AND "rate_bps" <= 10000);

-- ---------------------------------------------------------------------------
-- Effective ranges that run forwards.
--
-- Applies to both tables. A row whose `effective_to` precedes its
-- `effective_from` matches nothing, silently, forever — the rule simply never
-- fires and every invoice comes out UNRATED with no indication why.
-- ---------------------------------------------------------------------------
ALTER TABLE "issuer_tax_registrations" ADD CONSTRAINT "issuer_tax_registrations_effective_range"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_effective_range"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- ---------------------------------------------------------------------------
-- Backfill the branch's place of supply from its organization.
--
-- Right for the single-state clinic, which is nearly all of them. A group with
-- branches in two states must correct the second one before it bills there —
-- there is no way to infer it, because `branches.state` is free text written for
-- an address label and 'Karnataka' / 'KARNATAKA' / 'Karnatak' are three keys.
--
-- The column default of 'IN' covers a row whose organization somehow has none.
-- ---------------------------------------------------------------------------
UPDATE "branches" b
   SET "country_code" = o."country_code",
       "region_code"  = o."region_code"
  FROM "organizations" o
 WHERE o."id" = b."organization_id"
   AND o."country_code" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS. Both tables are the TENANT's own, unlike `tax_registrations`.
--
-- ⚠️ The reasoning that exempts `tax_registrations` does NOT transfer, and
--   copying it here would be the whole failure. That table holds rcln's numbers
--   and is read inside a tenant transaction, so a policy on it would return zero
--   rows and every subscription invoice would silently come out untaxed. These
--   rows belong to the organization reading them, so an ordinary
--   `tenant_isolation` policy returns exactly the right set — and without one,
--   one clinic reads another clinic's GSTIN and rate card.
--
-- Kept identical to prisma/rls/enable-rls.sql, which is the file db:rls:check
-- reads. Both must change together or the check passes on a database that has
-- drifted from the source.
-- ---------------------------------------------------------------------------
ALTER TABLE "issuer_tax_registrations" ENABLE   ROW LEVEL SECURITY;
-- Explicit: the owner must keep bypassing, so migrations and seeds work.
ALTER TABLE "issuer_tax_registrations" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "issuer_tax_registrations";
CREATE POLICY tenant_isolation ON "issuer_tax_registrations"
  USING ("organization_id" = app_current_org())
  WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "tax_rules" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "tax_rules" NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tax_rules";
CREATE POLICY tenant_isolation ON "tax_rules"
  USING ("organization_id" = app_current_org())
  WITH CHECK ("organization_id" = app_current_org());

-- No GRANT here: `ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner` in
-- infra/postgres/init already gives rcln_app DML on every table the owner
-- creates, which is why no other migration grants either.
