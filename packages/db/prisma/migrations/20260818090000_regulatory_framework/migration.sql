-- CreateEnum
CREATE TYPE "RulePackMaturity" AS ENUM ('ARCHITECTURE_SUPPORTED', 'RULES_CONFIGURED', 'RULES_IMPLEMENTED', 'AUTOMATED_TESTED', 'SOURCE_VERIFIED', 'REGULATORY_REVIEW_PENDING', 'REGULATORY_REVIEWED', 'PRODUCTION_ENABLED');

-- CreateEnum
CREATE TYPE "RegulatoryRuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RegulatoryRuleType" AS ENUM ('PRESCRIPTION_REQUIRED', 'PRESCRIBER_AUTHORITY', 'PHARMACIST_AUTHORITY', 'CONTROLLED_SCHEDULE', 'QUANTITY_LIMIT', 'REFILL_RULE', 'AGE_RESTRICTION', 'SUBSTITUTION', 'ONLINE_DISPENSING', 'STORAGE_REQUIREMENT', 'RECORD_RETENTION', 'TRACEABILITY_REQUIREMENT', 'LABELLING_REQUIREMENT', 'REPORTING_REQUIREMENT', 'DISPOSAL_REQUIREMENT', 'IMPORT_RESTRICTION');

-- CreateEnum
CREATE TYPE "RegulatoryTransactionType" AS ENUM ('DISPENSE', 'COUNTER_SALE', 'ONLINE_DISPENSE', 'CONSUME', 'STOCK', 'TRANSFER', 'DISPOSE');

-- CreateEnum
CREATE TYPE "RegulatorySourceStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'UNAVAILABLE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ProductRegistrationStatus" AS ENUM ('UNKNOWN', 'NOT_REGISTERED', 'PENDING', 'REGISTERED', 'SUSPENDED', 'CANCELLED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PrescriptionRequirement" AS ENUM ('UNKNOWN', 'NOT_REQUIRED', 'PHARMACIST_ONLY', 'PRESCRIPTION_REQUIRED', 'CONTROLLED');

-- CreateEnum
CREATE TYPE "OnlineSalePosition" AS ENUM ('UNKNOWN', 'PERMITTED', 'RESTRICTED', 'PROHIBITED');

-- CreateTable
CREATE TABLE "jurisdictions" (
    "id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(16),
    "name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jurisdictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_authorities" (
    "id" UUID NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "website_url" VARCHAR(500),
    "remit" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "regulatory_authorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_sources" (
    "id" UUID NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "authority_id" UUID NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "document_reference" VARCHAR(255),
    "source_url" VARCHAR(1000),
    "version" VARCHAR(64),
    "published_on" DATE,
    "effective_from" DATE,
    "retrieved_at" TIMESTAMPTZ(6),
    "review_status" "RegulatorySourceStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "regulatory_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_rule_packs" (
    "id" UUID NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "authority_id" UUID NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "maturity" "RulePackMaturity" NOT NULL DEFAULT 'ARCHITECTURE_SUPPORTED',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "last_reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" VARCHAR(255),
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "regulatory_rule_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_rules" (
    "id" UUID NOT NULL,
    "pack_id" UUID NOT NULL,
    "rule_type" "RegulatoryRuleType" NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "RegulatoryRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "applies_to_product_type" "ProductType",
    "applies_to_category_id" UUID,
    "applies_to_classification" VARCHAR(64),
    "applies_to_transactions" "RegulatoryTransactionType"[],
    "parameters" JSONB NOT NULL,
    "source_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "regulatory_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_regulatory_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "product_id" UUID NOT NULL,
    "jurisdiction_id" UUID NOT NULL,
    "registration_number" VARCHAR(128),
    "registration_status" "ProductRegistrationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "classification" VARCHAR(64),
    "controlled_schedule" VARCHAR(64),
    "prescription_requirement" "PrescriptionRequirement" NOT NULL DEFAULT 'UNKNOWN',
    "online_sale_position" "OnlineSalePosition" NOT NULL DEFAULT 'UNKNOWN',
    "dispensing_notes" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_regulatory_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jurisdictions_country_code_is_active_idx" ON "jurisdictions"("country_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "jurisdictions_country_code_region_code_key" ON "jurisdictions"("country_code", "region_code");

-- CreateIndex
CREATE INDEX "regulatory_authorities_jurisdiction_id_is_active_idx" ON "regulatory_authorities"("jurisdiction_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_authorities_code_key" ON "regulatory_authorities"("code");

-- CreateIndex
CREATE INDEX "regulatory_sources_jurisdiction_id_review_status_idx" ON "regulatory_sources"("jurisdiction_id", "review_status");

-- CreateIndex
CREATE INDEX "regulatory_sources_authority_id_idx" ON "regulatory_sources"("authority_id");

-- CreateIndex
CREATE INDEX "regulatory_rule_packs_jurisdiction_id_maturity_idx" ON "regulatory_rule_packs"("jurisdiction_id", "maturity");

-- CreateIndex
CREATE INDEX "regulatory_rule_packs_jurisdiction_id_effective_from_idx" ON "regulatory_rule_packs"("jurisdiction_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_rule_packs_jurisdiction_id_version_key" ON "regulatory_rule_packs"("jurisdiction_id", "version");

-- CreateIndex
CREATE INDEX "regulatory_rules_pack_id_rule_type_status_idx" ON "regulatory_rules"("pack_id", "rule_type", "status");

-- CreateIndex
CREATE INDEX "regulatory_rules_pack_id_effective_from_idx" ON "regulatory_rules"("pack_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_rules_pack_id_code_version_key" ON "regulatory_rules"("pack_id", "code", "version");

-- CreateIndex
CREATE INDEX "product_regulatory_profiles_organization_id_product_id_idx" ON "product_regulatory_profiles"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "product_regulatory_profiles_organization_id_jurisdiction_id_idx" ON "product_regulatory_profiles"("organization_id", "jurisdiction_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_regulatory_profiles_organization_id_product_id_juri_key" ON "product_regulatory_profiles"("organization_id", "product_id", "jurisdiction_id", "effective_from");

-- AddForeignKey
ALTER TABLE "regulatory_authorities" ADD CONSTRAINT "regulatory_authorities_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_sources" ADD CONSTRAINT "regulatory_sources_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_sources" ADD CONSTRAINT "regulatory_sources_authority_id_fkey" FOREIGN KEY ("authority_id") REFERENCES "regulatory_authorities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_rule_packs" ADD CONSTRAINT "regulatory_rule_packs_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_rule_packs" ADD CONSTRAINT "regulatory_rule_packs_authority_id_fkey" FOREIGN KEY ("authority_id") REFERENCES "regulatory_authorities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_rule_packs" ADD CONSTRAINT "regulatory_rule_packs_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_rules" ADD CONSTRAINT "regulatory_rules_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "regulatory_rule_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_rules" ADD CONSTRAINT "regulatory_rules_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "regulatory_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_rules" ADD CONSTRAINT "regulatory_rules_applies_to_category_id_fkey" FOREIGN KEY ("applies_to_category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_jurisdiction_id_fkey" FOREIGN KEY ("jurisdiction_id") REFERENCES "jurisdictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Everything below this line is hand-written. Prisma Migrate generates none of
-- it and would not notice its absence.
--
-- PI-5 — the regulatory FRAMEWORK. It contains no country's rules, deliberately.
-- ⚠️ NOTHING HERE CLAIMS LEGAL COMPLIANCE FOR ANY JURISDICTION.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT.
--
-- ⚠️ A PLAIN UNIQUE INDEX DOES NOT CONSTRAIN NULLABLE COLUMNS AT ALL, and in
--   both of these the NULL is the COMMON case rather than the edge one:
--   `jurisdictions.region_code` is NULL for every country-wide row, and
--   `product_regulatory_profiles.organization_id` is NULL for every platform
--   row. Without this, `IN` can be inserted twice and the second one wins
--   whichever query reaches it first.
-- ---------------------------------------------------------------------------
DROP INDEX "jurisdictions_country_code_region_code_key";
CREATE UNIQUE INDEX "jurisdictions_country_code_region_code_key"
  ON "jurisdictions" ("country_code", "region_code") NULLS NOT DISTINCT;

DROP INDEX "product_regulatory_profiles_organization_id_product_id_juri_key";
CREATE UNIQUE INDEX "product_regulatory_profiles_organization_id_product_id_juri_key"
  ON "product_regulatory_profiles"
     ("organization_id", "product_id", "jurisdiction_id", "effective_from")
  NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Effective windows. A row that ends before it begins never applies, and it is
-- indistinguishable in a screen from one that does.
-- ---------------------------------------------------------------------------
ALTER TABLE "regulatory_rule_packs" ADD CONSTRAINT "regulatory_rule_packs_effective_window"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "regulatory_rules" ADD CONSTRAINT "regulatory_rules_effective_window"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "product_regulatory_profiles" ADD CONSTRAINT "product_regulatory_profiles_effective_window"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- ISO 3166 is uppercase, and both sides of every jurisdiction comparison in the
-- programme assume it. A lowercase `in` matches nothing and looks configured.
ALTER TABLE "jurisdictions" ADD CONSTRAINT "jurisdictions_codes_uppercase"
  CHECK ("country_code" = upper("country_code")
         AND ("region_code" IS NULL OR "region_code" = upper("region_code")));

-- ---------------------------------------------------------------------------
-- ⚠️ THE SIGN-OFF CONSTRAINT. THE MOST IMPORTANT LINE IN THIS FILE.
--
-- PI-ADR-009: no code path, migration, seed, script or agent may set
-- `REGULATORY_REVIEWED` or `PRODUCTION_ENABLED`. Those are a named human's
-- decision, and the platform's position on a jurisdiction's law rests entirely
-- on somebody having actually made it.
--
-- The service refuses the transition unless the caller holds
-- `regulatory.pack.approve` and names the reviewer. This is the second layer,
-- and it is the one that survives a service somebody writes in PI-13 that
-- forgets the first: a pack cannot ARRIVE in either state without a reviewer's
-- name and the instant it was recorded. An UPDATE that only sets `maturity`
-- fails, which is precisely the shortcut a later migration or a psql session
-- would take.
--
-- ⚠️ IT CANNOT CHECK WHETHER THE NAME IS TRUE, AND NOTHING CAN. What it
--   guarantees is that somebody had to write one down, on the record, beside
--   the state — so the question "who signed India off?" always has an answer,
--   even when the answer turns out to be embarrassing.
-- ---------------------------------------------------------------------------
ALTER TABLE "regulatory_rule_packs" ADD CONSTRAINT "regulatory_rule_packs_review_recorded"
  CHECK (
    "maturity" NOT IN ('REGULATORY_REVIEWED', 'PRODUCTION_ENABLED')
    OR ("reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- ⚠️ A PLATFORM RULE MAY ONLY NAME A PLATFORM CATEGORY.
--
-- `regulatory_rules` has NO RLS POLICY — it is the law, every tenant reads it
-- inside its own transaction, and a policy would return zero rows for everyone
-- (see the exemption reasoning in enable-rls.sql). `product_categories` is
-- platform-EXTENSIBLE, so `applies_to_category_id` is a plain FK that could name
-- one clinic's private category. Every other clinic would then read that
-- category's NAME back out of the rule screen's join — a cross-tenant read
-- through a table with no policy to stop it.
--
-- Elsewhere in this schema that hole is closed by a RESTRICTIVE `*_visible`
-- policy on the CHILD. That does not work here, because the child is exempt: a
-- policy on it is exactly the thing that breaks the domain. So the fix is
-- upstream and absolute — platform law may only speak about platform categories,
-- and the FK is refused at write time rather than filtered at read time.
--
-- SECURITY INVOKER and a pinned search_path, for the same reasons as
-- `refuse_platform_row_mutation` above it: it reads one row, needs no privilege,
-- and must not become privileged surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_tenant_category_on_regulatory_rule() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS
$$
DECLARE
  owner_org uuid;
BEGIN
  IF NEW.applies_to_category_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.organization_id INTO owner_org
    FROM public.product_categories c
   WHERE c.id = NEW.applies_to_category_id;

  IF owner_org IS NOT NULL THEN
    RAISE EXCEPTION
      'regulatory rule % may not apply to a tenant-owned product category', NEW.code
      USING ERRCODE = 'insufficient_privilege',
            HINT    = 'A rule pack is platform law. Narrow it with a platform category, a product type or a classification string.';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER regulatory_rule_category_is_platform
  BEFORE INSERT OR UPDATE ON "regulatory_rules"
  FOR EACH ROW EXECUTE FUNCTION refuse_tenant_category_on_regulatory_rule();

-- ---------------------------------------------------------------------------
-- RLS — `product_regulatory_profiles` only.
--
-- It joins the `platform_extensible` array: read-permissive, write-strict, plus
-- the `platform_rows_immutable` trigger, exactly like the twelve catalogue
-- tables it sits beside. Copied out of enable-rls.sql rather than referenced,
-- because a migration has to be self-contained.
--
-- ⚠️ NO `product_visible` POLICY, AND THAT IS NOT AN OMISSION. The FK to
--   `products` is COMPOSITE — `(organization_id, product_id) -> products
--   (organization_id, id)` — so a tenant row can only ever hang off a
--   same-tenant product and there is nothing left for a visibility policy to
--   close. `*_visible` exists for the PLAIN FKs, which is why `batches` has one
--   and `product_packagings` does not.
--
-- ⚠️ AND NO `jurisdiction_visible` EITHER, for a different reason: `jurisdictions`
--   has no `organization_id` AT ALL, so there is no such thing as another
--   tenant's jurisdiction to leak. Every row in it is platform data every clinic
--   may read. The day anybody adds a tenant column to that table, this paragraph
--   becomes wrong and a policy becomes required.
-- ---------------------------------------------------------------------------
ALTER TABLE "product_regulatory_profiles" ENABLE   ROW LEVEL SECURITY;
ALTER TABLE "product_regulatory_profiles" NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "product_regulatory_profiles";
CREATE POLICY tenant_isolation ON "product_regulatory_profiles"
  USING      (organization_id IS NULL OR organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

DROP TRIGGER IF EXISTS platform_rows_immutable ON "product_regulatory_profiles";
CREATE TRIGGER platform_rows_immutable
  BEFORE UPDATE OR DELETE ON "product_regulatory_profiles"
  FOR EACH ROW EXECUTE FUNCTION refuse_platform_row_mutation();

-- ---------------------------------------------------------------------------
-- ⚠️ NO CLINIC WRITES THE LAW.
--
-- The five platform tables have no `organization_id`, so they have no RLS
-- policy and nothing about a tenant's session narrows them. What distinguishes a
-- tenant request from the platform console is not the ROLE — both connect as
-- `rcln_app`, `@rcln/db/unsafe` included — but whether the transaction claims a
-- tenant at all. `withTenant` sets `app.current_org`; the platform router and
-- the seeds set nothing.
--
-- That is the same test `refuse_platform_row_mutation` makes, for the same
-- reason, and it is the only honest one available here.
--
-- ⚠️ IT IS A SECOND LAYER, NOT THE FIRST. The platform router's admin guard is
--   the first, and it is the one that produces a 403 a human can read. This one
--   exists for the service somebody adds in PI-13 that reaches these tables from
--   a tenant path — the failure that would otherwise be silent, platform-wide,
--   and about the rules a pharmacist is trusting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_tenant_write_to_platform_law() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS
$$
BEGIN
  IF app_current_org() IS NOT NULL THEN
    RAISE EXCEPTION
      '% is platform regulatory data and is not writable from a tenant request', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege',
            HINT    = 'Rule packs are maintained in the platform console. A clinic configures product regulatory profiles instead.';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jurisdictions',
    'regulatory_authorities',
    'regulatory_sources',
    'regulatory_rule_packs',
    'regulatory_rules'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS platform_law_not_tenant_writable ON %I', t);
    EXECUTE format($f$
      CREATE TRIGGER platform_law_not_tenant_writable
        BEFORE INSERT OR UPDATE OR DELETE ON %I
        FOR EACH ROW EXECUTE FUNCTION refuse_tenant_write_to_platform_law()
    $f$, t);
  END LOOP;
END
$$;

-- ===========================================================================
-- Grants.
--
-- ⚠️ THE INIT SCRIPT'S BLANKET `GRANT ... ON ALL TABLES` RAN LONG BEFORE THESE
--   TABLES EXISTED, so without this the first request fails with a flat
--   `permission denied for table jurisdictions`. The same trap PI-2, PI-3 and
--   PI-4 each hit. `scripts/apply-grants.ts` re-applies these after a reset.
--
-- ⚠️ THE FIVE PLATFORM TABLES CARRY NO RLS POLICY — they cannot, for the reason
--   written into enable-rls.sql — so ordinarily the grant would be the ONLY
--   thing between a tenant request and the law every other clinic is evaluated
--   against. `@rcln/db/unsafe` is NOT an owner connection: it is the same
--   `rcln_app` role with no session variables set. So a SELECT-only grant would
--   mean the platform console could not write them either, and revoking write
--   entirely is not available.
--
--   The second layer is `refuse_tenant_write_to_platform_law` below, which uses
--   the SAME discriminator `refuse_platform_row_mutation` already uses:
--   `app_current_org() IS NOT NULL` means the caller is acting on a clinic's
--   behalf, and no clinic writes the law. The platform console sets no tenant
--   context, so it passes; the seeds set none either. A tenant-path service
--   written in PI-13 that forgets its middleware is refused by the database.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "jurisdictions"          TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "regulatory_authorities" TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "regulatory_sources"     TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "regulatory_rule_packs"  TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "regulatory_rules"       TO rcln_app;

-- The tenant's own assertions about its own products. Ordinary read/write.
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_regulatory_profiles" TO rcln_app;
