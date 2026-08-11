-- PI-1 — Product Platform Core.
--
-- Thirteen tables that answer "what is this thing?". Nothing here has a
-- quantity, a location or a price; the ledger lands in PI-2. Read
-- prisma/schema/products.prisma for the model-level reasoning, and
-- .kb/PharmacyInventory/ARCHITECTURE.md for the decisions behind it.
--
-- ── EVERYTHING BELOW THE PRISMA OUTPUT IS HAND-WRITTEN, AND NONE OF IT IS
--    DECORATION ──────────────────────────────────────────────────────────────
--   · NULLS NOT DISTINCT on every unique index. EVERY ONE of them contains
--     `organization_id`, which is nullable on every table in this migration
--     because NULL means a platform row. A plain unique index does not
--     constrain NULLs at all, so without this rewrite the platform catalogue is
--     not unique against itself — two platform products could both be `AMOX500`.
--   · CHECK constraints Prisma cannot express.
--   · Two triggers Prisma cannot express: unit-class agreement on a conversion,
--     and acyclicity of the category tree.
--   · The RLS policies. Prisma Migrate does not generate these, and a tenant
--     table without one returns other clinics' rows silently — see
--     prisma/rls/enable-rls.sql, which carries the same stanzas.
--
-- ⚠️ THE UNIQUE INDEXES ARE REPLACED UNDER PRISMA'S OWN NAMES, NOT RENAMED TO
--   SOMETHING DESCRIPTIVE. `fee_schedule_entries_scope_key` did the latter and
--   the result is permanent drift: every `prisma migrate dev` since has wanted
--   to rename it back. Keep the generated name and the diff stays empty.

-- CreateEnum
CREATE TYPE "UnitClass" AS ENUM ('COUNT', 'VOLUME', 'MASS', 'LENGTH', 'AREA');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('MEDICINE', 'VACCINE', 'CONSUMABLE', 'SURGICAL_SUPPLY', 'MEDICAL_DEVICE', 'IMPLANT', 'DENTAL_MATERIAL', 'LAB_REAGENT', 'DIAGNOSTIC_KIT', 'VETERINARY_MEDICINE', 'VETERINARY_CONSUMABLE', 'GENERAL_CLINICAL_SUPPLY');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISCONTINUED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TrackingMode" AS ENUM ('NONE', 'LOT_BATCH', 'SERIAL', 'LOT_AND_SERIAL');

-- CreateEnum
CREATE TYPE "ProductIdentifierType" AS ENUM ('GTIN', 'EAN', 'UPC', 'NDC', 'NATIONAL_CODE', 'MANUFACTURER_CODE', 'INTERNAL_SKU', 'LOCAL_REGULATORY');

-- CreateEnum
CREATE TYPE "DosageForm" AS ENUM ('TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'SOLUTION', 'INJECTION', 'INFUSION', 'CREAM', 'OINTMENT', 'GEL', 'LOTION', 'DROPS', 'SPRAY', 'INHALER', 'PATCH', 'SUPPOSITORY', 'PESSARY', 'POWDER', 'GRANULES', 'LOZENGE', 'IMPLANT', 'OTHER');

-- CreateEnum
CREATE TYPE "AdministrationRoute" AS ENUM ('ORAL', 'SUBLINGUAL', 'BUCCAL', 'INTRAVENOUS', 'INTRAMUSCULAR', 'SUBCUTANEOUS', 'INTRADERMAL', 'TOPICAL', 'TRANSDERMAL', 'INHALATION', 'NASAL', 'OPHTHALMIC', 'OTIC', 'RECTAL', 'VAGINAL', 'INTRATHECAL', 'INTRA_ARTICULAR', 'OTHER');

-- CreateEnum
CREATE TYPE "ReleaseType" AS ENUM ('IMMEDIATE', 'MODIFIED', 'SUSTAINED', 'EXTENDED', 'DELAYED', 'CONTROLLED');

-- CreateEnum
CREATE TYPE "LightSensitivity" AS ENUM ('NONE', 'PROTECT_FROM_LIGHT', 'PROTECT_FROM_DIRECT_SUNLIGHT');

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "symbol" VARCHAR(16) NOT NULL,
    "unit_class" "UnitClass" NOT NULL,
    "is_base" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_conversions" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "from_unit_id" UUID NOT NULL,
    "to_unit_id" UUID NOT NULL,
    "numerator" BIGINT NOT NULL,
    "denominator" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "unit_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "parent_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturers" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "country_code" CHAR(2),
    "licence_number" VARCHAR(128),
    "gs1_prefix" VARCHAR(16),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_ingredients" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "inn_name" VARCHAR(255),
    "synonyms" JSONB,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "active_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compositions" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(500) NOT NULL,
    "dosage_form" "DosageForm",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "compositions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "composition_ingredients" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "composition_id" UUID NOT NULL,
    "ingredient_id" UUID NOT NULL,
    "strength" DECIMAL(14,6) NOT NULL,
    "strength_unit_id" UUID NOT NULL,
    "per_quantity" DECIMAL(14,6),
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "composition_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_requirement_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "min_temperature_c" DECIMAL(5,2),
    "max_temperature_c" DECIMAL(5,2),
    "min_humidity_pct" INTEGER,
    "max_humidity_pct" INTEGER,
    "light_sensitivity" "LightSensitivity" NOT NULL DEFAULT 'NONE',
    "requires_controlled_access" BOOLEAN NOT NULL DEFAULT false,
    "hazard_class" VARCHAR(64),
    "handling_notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "storage_requirement_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "type" "ProductType" NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(500) NOT NULL,
    "brand_name" VARCHAR(255),
    "generic_name" VARCHAR(255),
    "description" TEXT,
    "category_id" UUID,
    "manufacturer_id" UUID,
    "composition_id" UUID,
    "storage_profile_id" UUID,
    "base_unit_id" UUID NOT NULL,
    "tracking_mode" "TrackingMode" NOT NULL DEFAULT 'NONE',
    "is_expiry_controlled" BOOLEAN NOT NULL DEFAULT false,
    "default_shelf_life_days" INTEGER,
    "reorder_level_base" DECIMAL(18,6),
    "reorder_quantity_base" DECIMAL(18,6),
    "is_stock_item" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_packagings" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "product_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity_of_child" DECIMAL(18,6) NOT NULL,
    "is_default_purchase" BOOLEAN NOT NULL DEFAULT false,
    "is_default_sale" BOOLEAN NOT NULL DEFAULT false,
    "barcode" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_packagings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_identifiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "product_id" UUID NOT NULL,
    "type" "ProductIdentifierType" NOT NULL,
    "value" VARCHAR(128) NOT NULL,
    "country_code" CHAR(2),
    "effective_from" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" DATE,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_tax_classifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "product_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(16),
    "tax_category" VARCHAR(64) NOT NULL,
    "item_code" VARCHAR(32),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_tax_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicine_details" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "product_id" UUID NOT NULL,
    "dosage_form" "DosageForm",
    "route" "AdministrationRoute",
    "release_type" "ReleaseType",
    "is_narrow_therapeutic_index" BOOLEAN NOT NULL DEFAULT false,
    "prescription_classification_hint" VARCHAR(64),
    "label_instructions" TEXT,
    "default_course_days" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "medicine_details_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "units_of_measure_organization_id_unit_class_is_active_idx" ON "units_of_measure"("organization_id", "unit_class", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_organization_id_code_key" ON "units_of_measure"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_organization_id_id_key" ON "units_of_measure"("organization_id", "id");

-- CreateIndex
CREATE INDEX "unit_conversions_organization_id_from_unit_id_idx" ON "unit_conversions"("organization_id", "from_unit_id");

-- CreateIndex
CREATE INDEX "unit_conversions_organization_id_to_unit_id_idx" ON "unit_conversions"("organization_id", "to_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_conversions_organization_id_from_unit_id_to_unit_id_key" ON "unit_conversions"("organization_id", "from_unit_id", "to_unit_id");

-- CreateIndex
CREATE INDEX "product_categories_organization_id_is_active_idx" ON "product_categories"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "product_categories_parent_id_idx" ON "product_categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_organization_id_code_key" ON "product_categories"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_organization_id_id_key" ON "product_categories"("organization_id", "id");

-- CreateIndex
CREATE INDEX "manufacturers_organization_id_is_active_idx" ON "manufacturers"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "manufacturers_organization_id_country_code_idx" ON "manufacturers"("organization_id", "country_code");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturers_organization_id_code_key" ON "manufacturers"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturers_organization_id_id_key" ON "manufacturers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "active_ingredients_organization_id_is_active_idx" ON "active_ingredients"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "active_ingredients_organization_id_code_key" ON "active_ingredients"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "active_ingredients_organization_id_id_key" ON "active_ingredients"("organization_id", "id");

-- CreateIndex
CREATE INDEX "compositions_organization_id_is_active_idx" ON "compositions"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "compositions_organization_id_code_key" ON "compositions"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "compositions_organization_id_id_key" ON "compositions"("organization_id", "id");

-- CreateIndex
CREATE INDEX "composition_ingredients_organization_id_ingredient_id_idx" ON "composition_ingredients"("organization_id", "ingredient_id");

-- CreateIndex
CREATE UNIQUE INDEX "composition_ingredients_organization_id_composition_id_ingr_key" ON "composition_ingredients"("organization_id", "composition_id", "ingredient_id");

-- CreateIndex
CREATE INDEX "storage_requirement_profiles_organization_id_is_active_idx" ON "storage_requirement_profiles"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "storage_requirement_profiles_organization_id_code_key" ON "storage_requirement_profiles"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "storage_requirement_profiles_organization_id_id_key" ON "storage_requirement_profiles"("organization_id", "id");

-- CreateIndex
CREATE INDEX "products_organization_id_status_type_idx" ON "products"("organization_id", "status", "type");

-- CreateIndex
CREATE INDEX "products_organization_id_category_id_idx" ON "products"("organization_id", "category_id");

-- CreateIndex
CREATE INDEX "products_organization_id_composition_id_idx" ON "products"("organization_id", "composition_id");

-- CreateIndex
CREATE INDEX "products_organization_id_manufacturer_id_idx" ON "products"("organization_id", "manufacturer_id");

-- CreateIndex
CREATE INDEX "products_organization_id_name_idx" ON "products"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_code_key" ON "products"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_id_key" ON "products"("organization_id", "id");

-- CreateIndex
CREATE INDEX "product_packagings_organization_id_product_id_idx" ON "product_packagings"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_packagings_organization_id_product_id_level_key" ON "product_packagings"("organization_id", "product_id", "level");

-- CreateIndex
CREATE INDEX "product_identifiers_organization_id_type_value_idx" ON "product_identifiers"("organization_id", "type", "value");

-- CreateIndex
CREATE INDEX "product_identifiers_organization_id_product_id_idx" ON "product_identifiers"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_identifiers_organization_id_type_value_country_code_key" ON "product_identifiers"("organization_id", "type", "value", "country_code");

-- CreateIndex
CREATE INDEX "product_tax_classifications_organization_id_product_id_coun_idx" ON "product_tax_classifications"("organization_id", "product_id", "country_code");

-- CreateIndex
CREATE UNIQUE INDEX "product_tax_classifications_organization_id_product_id_coun_key" ON "product_tax_classifications"("organization_id", "product_id", "country_code", "region_code", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "medicine_details_organization_id_product_id_key" ON "medicine_details"("organization_id", "product_id");

-- AddForeignKey
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_from_unit_id_fkey" FOREIGN KEY ("from_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_conversions" ADD CONSTRAINT "unit_conversions_to_unit_id_fkey" FOREIGN KEY ("to_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manufacturers" ADD CONSTRAINT "manufacturers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_ingredients" ADD CONSTRAINT "active_ingredients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compositions" ADD CONSTRAINT "compositions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "composition_ingredients" ADD CONSTRAINT "composition_ingredients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "composition_ingredients" ADD CONSTRAINT "composition_ingredients_organization_id_composition_id_fkey" FOREIGN KEY ("organization_id", "composition_id") REFERENCES "compositions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "composition_ingredients" ADD CONSTRAINT "composition_ingredients_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "active_ingredients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "composition_ingredients" ADD CONSTRAINT "composition_ingredients_strength_unit_id_fkey" FOREIGN KEY ("strength_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_requirement_profiles" ADD CONSTRAINT "storage_requirement_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_composition_id_fkey" FOREIGN KEY ("composition_id") REFERENCES "compositions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_storage_profile_id_fkey" FOREIGN KEY ("storage_profile_id") REFERENCES "storage_requirement_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_packagings" ADD CONSTRAINT "product_packagings_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_tax_classifications" ADD CONSTRAINT "product_tax_classifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_tax_classifications" ADD CONSTRAINT "product_tax_classifications_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_details" ADD CONSTRAINT "medicine_details_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_details" ADD CONSTRAINT "medicine_details_organization_id_product_id_fkey" FOREIGN KEY ("organization_id", "product_id") REFERENCES "products"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- HAND-WRITTEN FROM HERE DOWN. See the header.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT on every unique index in this migration.
--
-- All of them contain `organization_id`, which is NULL on a platform row. Under
-- Postgres's default NULLS DISTINCT, two rows with a NULL organization_id are
-- unique against each other WHATEVER the other columns say — so the platform
-- catalogue would not be unique against itself, and the seed's `findFirst`
-- would silently start creating duplicates on its second run.
--
-- `product_identifiers` and `product_tax_classifications` each have a SECOND
-- nullable column in their key (`country_code`, `region_code`), so for those the
-- rewrite is load-bearing twice over.
--
-- Each is dropped and recreated under Prisma's own generated name. See the
-- warning in the header for why the name is kept rather than improved.
-- ---------------------------------------------------------------------------
-- ⚠️ THE `(organization_id, id)` COMPOSITE-FK TARGETS ARE DELIBERATELY LEFT
--   ALONE. `id` is the primary key, so those indexes are already unique on
--   their own whatever NULLs the first column holds — the rewrite would buy
--   nothing. It would also FAIL: they are the targets of the composite foreign
--   keys created above, and Postgres refuses to drop an index a constraint
--   depends on. Measured, not reasoned about.
DROP INDEX "units_of_measure_organization_id_code_key";
CREATE UNIQUE INDEX "units_of_measure_organization_id_code_key"
  ON "units_of_measure" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "unit_conversions_organization_id_from_unit_id_to_unit_id_key";
CREATE UNIQUE INDEX "unit_conversions_organization_id_from_unit_id_to_unit_id_key"
  ON "unit_conversions" ("organization_id", "from_unit_id", "to_unit_id") NULLS NOT DISTINCT;

DROP INDEX "product_categories_organization_id_code_key";
CREATE UNIQUE INDEX "product_categories_organization_id_code_key"
  ON "product_categories" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "manufacturers_organization_id_code_key";
CREATE UNIQUE INDEX "manufacturers_organization_id_code_key"
  ON "manufacturers" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "active_ingredients_organization_id_code_key";
CREATE UNIQUE INDEX "active_ingredients_organization_id_code_key"
  ON "active_ingredients" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "compositions_organization_id_code_key";
CREATE UNIQUE INDEX "compositions_organization_id_code_key"
  ON "compositions" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "composition_ingredients_organization_id_composition_id_ingr_key";
CREATE UNIQUE INDEX "composition_ingredients_organization_id_composition_id_ingr_key"
  ON "composition_ingredients" ("organization_id", "composition_id", "ingredient_id") NULLS NOT DISTINCT;

DROP INDEX "storage_requirement_profiles_organization_id_code_key";
CREATE UNIQUE INDEX "storage_requirement_profiles_organization_id_code_key"
  ON "storage_requirement_profiles" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "products_organization_id_code_key";
CREATE UNIQUE INDEX "products_organization_id_code_key"
  ON "products" ("organization_id", "code") NULLS NOT DISTINCT;

DROP INDEX "product_packagings_organization_id_product_id_level_key";
CREATE UNIQUE INDEX "product_packagings_organization_id_product_id_level_key"
  ON "product_packagings" ("organization_id", "product_id", "level") NULLS NOT DISTINCT;

-- ⚠️ TWO nullable columns in this one: organization_id AND country_code. A
--   platform GTIN with no country is the commonest row in the table, and under
--   NULLS DISTINCT every such row is unique against every other — the key would
--   have constrained nothing at all for exactly the rows it exists to constrain.
DROP INDEX "product_identifiers_organization_id_type_value_country_code_key";
CREATE UNIQUE INDEX "product_identifiers_organization_id_type_value_country_code_key"
  ON "product_identifiers" ("organization_id", "type", "value", "country_code") NULLS NOT DISTINCT;

-- Same shape: organization_id AND region_code. `region_code IS NULL` means
-- "the whole country", which is the ordinary case.
DROP INDEX "product_tax_classifications_organization_id_product_id_coun_key";
CREATE UNIQUE INDEX "product_tax_classifications_organization_id_product_id_coun_key"
  ON "product_tax_classifications" ("organization_id", "product_id", "country_code", "region_code", "effective_from")
  NULLS NOT DISTINCT;

DROP INDEX "medicine_details_organization_id_product_id_key";
CREATE UNIQUE INDEX "medicine_details_organization_id_product_id_key"
  ON "medicine_details" ("organization_id", "product_id") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Partial unique indexes. Prisma cannot express a `WHERE` clause on a unique.
-- ---------------------------------------------------------------------------

-- Exactly one base unit per class, and only the platform may declare one.
--
-- ⚠️ TWO BASE UNITS IN A CLASS IS WORSE THAN NONE. With none, a conversion
--   fails loudly. With two, the conversion graph has two roots: it resolves,
--   and it resolves differently depending on which row the planner reached
--   first. A stock figure that is right on Tuesday and wrong on Wednesday is
--   the hardest kind of bug to be told about.
CREATE UNIQUE INDEX "units_of_measure_one_platform_base"
  ON "units_of_measure" ("unit_class")
  WHERE "is_base" AND "organization_id" IS NULL;

-- At most one default purchase level and one default sale level per product.
-- Zero is legal: a product whose packaging is only the base unit needs neither.
CREATE UNIQUE INDEX "product_packagings_one_default_purchase"
  ON "product_packagings" ("organization_id", "product_id") NULLS NOT DISTINCT
  WHERE "is_default_purchase";

CREATE UNIQUE INDEX "product_packagings_one_default_sale"
  ON "product_packagings" ("organization_id", "product_id") NULLS NOT DISTINCT
  WHERE "is_default_sale";

-- At most one primary identifier per product per namespace. A product may hold
-- a GTIN and an NDC and mark both primary — they are different questions.
CREATE UNIQUE INDEX "product_identifiers_one_primary_per_type"
  ON "product_identifiers" ("organization_id", "product_id", "type") NULLS NOT DISTINCT
  WHERE "is_primary";

-- ---------------------------------------------------------------------------
-- CHECK constraints.
--
-- These are in the DATABASE rather than only in a service because the service is
-- not the only thing that writes here: seeds, migrations, imports and the next
-- domain to be built all reach the same tables. A rule enforced in one code path
-- is a rule until somebody writes a second code path.
-- ---------------------------------------------------------------------------

-- A zero denominator is a division by zero at every call site; a zero numerator
-- silently annihilates a quantity, which is worse because it succeeds.
ALTER TABLE "unit_conversions"
  ADD CONSTRAINT "unit_conversions_ratio_positive"
  CHECK ("numerator" > 0 AND "denominator" > 0);

-- A unit does not convert to itself through this table. The identity is implicit
-- and a row asserting it can disagree with itself (`1 TAB = 2 TAB`).
ALTER TABLE "unit_conversions"
  ADD CONSTRAINT "unit_conversions_distinct_units"
  CHECK ("from_unit_id" <> "to_unit_id");

-- Only the platform declares a base unit — see the partial index above. A tenant
-- adding its own base would give ITS conversion graph two roots while the
-- platform's stayed single-rooted, so the same product would convert differently
-- for two clinics.
ALTER TABLE "units_of_measure"
  ADD CONSTRAINT "units_of_measure_base_is_platform"
  CHECK (NOT "is_base" OR "organization_id" IS NULL);

ALTER TABLE "composition_ingredients"
  ADD CONSTRAINT "composition_ingredients_strength_positive"
  CHECK ("strength" > 0 AND ("per_quantity" IS NULL OR "per_quantity" > 0));

-- Level 0 IS the base unit, so one of it contains one of itself. Any other value
-- there silently multiplies every quantity in the hierarchy above it.
ALTER TABLE "product_packagings"
  ADD CONSTRAINT "product_packagings_level_sane"
  CHECK ("level" >= 0 AND "quantity_of_child" > 0
         AND ("level" > 0 OR "quantity_of_child" = 1));

ALTER TABLE "storage_requirement_profiles"
  ADD CONSTRAINT "storage_requirement_profiles_range_sane"
  CHECK (
    ("min_temperature_c" IS NULL OR "max_temperature_c" IS NULL
      OR "min_temperature_c" <= "max_temperature_c")
    AND ("min_humidity_pct" IS NULL OR ("min_humidity_pct" BETWEEN 0 AND 100))
    AND ("max_humidity_pct" IS NULL OR ("max_humidity_pct" BETWEEN 0 AND 100))
    AND ("min_humidity_pct" IS NULL OR "max_humidity_pct" IS NULL
      OR "min_humidity_pct" <= "max_humidity_pct")
  );

-- An effective window that ends before it starts matches nothing, so every
-- resolver quietly returns "not configured" and the gap looks like a missing row
-- rather than a typed date.
ALTER TABLE "product_identifiers"
  ADD CONSTRAINT "product_identifiers_window_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "product_tax_classifications"
  ADD CONSTRAINT "product_tax_classifications_window_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- ⚠️ EXPIRY NEEDS SOMEWHERE TO LIVE. `batches.expires_on` is the only column in
--   the programme that holds an expiry date, and a product with tracking_mode
--   NONE or SERIAL never gets a batch row. Marking such a product
--   expiry-controlled therefore asserts a control that no table can record, and
--   PI-2's expiry sweep would silently skip it forever.
ALTER TABLE "products"
  ADD CONSTRAINT "products_expiry_requires_batch_tracking"
  CHECK (NOT "is_expiry_controlled"
         OR "tracking_mode" IN ('LOT_BATCH', 'LOT_AND_SERIAL'));

ALTER TABLE "products"
  ADD CONSTRAINT "products_reorder_sane"
  CHECK (
    ("default_shelf_life_days" IS NULL OR "default_shelf_life_days" > 0)
    AND ("reorder_level_base" IS NULL OR "reorder_level_base" >= 0)
    AND ("reorder_quantity_base" IS NULL OR "reorder_quantity_base" > 0)
  );

-- ---------------------------------------------------------------------------
-- A conversion may not cross unit classes.
--
-- A trigger and not a CHECK, because a CHECK cannot see another table. There is
-- no general answer to "how many millilitres in a tablet": the honest one is a
-- property of a PRODUCT (its fill volume), and it belongs in
-- `product_packagings` where it is stated per product, not in a unit table where
-- it would apply to every product using those two units.
--
-- ⚠️ NOT OWNER-EXEMPT. Unlike the append-only triggers on audit_logs, there is
--   no legitimate writer of a cross-class conversion — not the app, not a seed,
--   not a migration. The seed writes ~30 conversions and this is exactly the
--   guard that catches a mistyped unit code among them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION unit_conversions_same_class() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  from_class "UnitClass";
  to_class   "UnitClass";
BEGIN
  SELECT "unit_class" INTO from_class FROM "units_of_measure" WHERE "id" = NEW."from_unit_id";
  SELECT "unit_class" INTO to_class   FROM "units_of_measure" WHERE "id" = NEW."to_unit_id";

  IF from_class IS DISTINCT FROM to_class THEN
    RAISE EXCEPTION 'unit conversion % -> % crosses unit classes (% -> %)',
      NEW."from_unit_id", NEW."to_unit_id", from_class, to_class
      USING HINT = 'A conversion between a count and a volume is a property of a product, not of a unit. Express it as product packaging instead.';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "unit_conversions_same_class"
  BEFORE INSERT OR UPDATE ON "unit_conversions"
  FOR EACH ROW EXECUTE FUNCTION unit_conversions_same_class();

-- ---------------------------------------------------------------------------
-- Acyclicity of the category tree.
--
-- Identical in shape and reasoning to `specialties_reject_cycle`, because it is
-- the same adjacency list solving the same problem. A cycle is not a bad row, it
-- is a HANG: every ancestor walk, descendant walk and breadcrumb render recurses
-- until the statement timeout. `WITH RECURSIVE` spins forever on A -> B -> A.
--
-- ⚠️ NOT OWNER-EXEMPT, for the same reason as the specialties one: a cycle is
--   never legitimate from any writer, and the seed is the likeliest place to
--   introduce one by mistyping a parent code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION product_categories_reject_cycle() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  cursor_id uuid;
  hops      int := 0;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."parent_id" = NEW."id" THEN
    RAISE EXCEPTION 'product category % cannot be its own parent', NEW."id"
      USING HINT = 'A category''s parent must be a different category.';
  END IF;

  -- Walk up from the proposed parent. Terminates either at a root
  -- (parent_id IS NULL) or back at NEW.id, which is the cycle. The hop counter
  -- is a backstop for a cycle that ALREADY exists further up the chain and so
  -- does not pass through NEW.id — without it this loop hangs on pre-existing
  -- corruption while trying to prevent new corruption.
  cursor_id := NEW."parent_id";
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW."id" THEN
      RAISE EXCEPTION 'product category % cannot be a descendant of itself', NEW."id"
        USING HINT = format('Re-parenting it under %s would close a cycle.', NEW."parent_id");
    END IF;

    hops := hops + 1;
    IF hops > 64 THEN
      RAISE EXCEPTION 'product category ancestry exceeded 64 levels from %', NEW."id"
        USING HINT = 'The tree above this node is already cyclic or absurdly deep.';
    END IF;

    SELECT "parent_id" INTO cursor_id FROM "product_categories" WHERE "id" = cursor_id;
  END LOOP;

  RETURN NEW;
END
$$;

CREATE TRIGGER "product_categories_no_cycle"
  BEFORE INSERT OR UPDATE ON "product_categories"
  FOR EACH ROW EXECUTE FUNCTION product_categories_reject_cycle();

-- ===========================================================================
-- ROW-LEVEL SECURITY
--
-- Mirrors the stanzas added to prisma/rls/enable-rls.sql in the same commit.
-- ⚠️ IF YOU CHANGE ONE, CHANGE THE OTHER. `pnpm db:rls:check` catches a table
--   with NO policy; it cannot catch two files disagreeing about which policy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- All thirteen are PLATFORM CATALOGUE + TENANT EXTENSION.
--
-- ⚠️ READ IS PERMISSIVE, WRITE IS NOT. This is NOT the `files` policy. Copying
--   the NULL-permissive WITH CHECK from there would let ANY CLINIC INSERT A
--   PLATFORM-WIDE PRODUCT — organization_id NULL, instantly visible to every
--   other tenant on the platform, writable by anyone holding
--   product.definition.manage. That is a cross-tenant write dressed up as a
--   catalogue entry, and nothing else in the system would notice: it is a valid
--   insert into a table the caller is allowed to write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  platform_extensible text[] := ARRAY[
    'units_of_measure',
    'unit_conversions',
    'product_categories',
    'manufacturers',
    'active_ingredients',
    'compositions',
    'composition_ingredients',
    'storage_requirement_profiles',
    'products',
    'product_packagings',
    'product_identifiers',
    'product_tax_classifications',
    'medicine_details'
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

-- ---------------------------------------------------------------------------
-- The RESTRICTIVE visibility policies. THE highest-risk item in PI-1.
--
-- Every foreign key below points at a table whose rows may be PLATFORM rows, so
-- it cannot be a composite `(organization_id, id)` FK — there is no
-- organization_id on the target to compose with. `tenant_isolation` therefore
-- constrains the ROW'S OWN organization_id and says nothing whatsoever about
-- what it points AT. Without these a clinic attaches another clinic's private
-- category, ingredient, composition or unit to its own row and reads the name
-- back out through the join.
--
-- Same shape and same reasoning as `specialty_visible` on `doctor_specialties`,
-- which is the precedent this copies. RESTRICTIVE so each ANDs with
-- tenant_isolation rather than ORing with it — a PERMISSIVE policy here would
-- WIDEN access instead of narrowing it, which is the exact opposite of the
-- intent and would typecheck, deploy and pass every single-tenant test.
--
-- A helper is used rather than thirteen copies of the same EXISTS, because the
-- copies are where one of them ends up subtly different.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  i int;
  child text;
  fk text;
  parent text;
  policy_name text;
  nullable boolean;
  predicate text;
  -- child table, FK column on the child, parent table, policy name, FK nullable
  visible text[][] := ARRAY[
    ARRAY['unit_conversions',        'from_unit_id',       'units_of_measure',             'from_unit_visible',       'f'],
    ARRAY['unit_conversions',        'to_unit_id',         'units_of_measure',             'to_unit_visible',         'f'],
    -- The self-parent. `specialties` does NOT carry the equivalent policy, and
    -- this is a deliberate tightening rather than an inconsistency: without it a
    -- clinic can hang its own category under another clinic's private one, which
    -- leaks nothing readable (the ancestor walk runs under RLS and drops the
    -- row) but does confirm that a guessed id exists, and leaves a tenant tree
    -- rooted somewhere it cannot see. Refusing the write is cheaper than
    -- explaining the orphan.
    ARRAY['product_categories',      'parent_id',          'product_categories',           'parent_visible',          't'],
    ARRAY['composition_ingredients', 'ingredient_id',      'active_ingredients',           'ingredient_visible',      'f'],
    ARRAY['composition_ingredients', 'strength_unit_id',   'units_of_measure',             'strength_unit_visible',   'f'],
    ARRAY['products',                'category_id',        'product_categories',           'category_visible',        't'],
    ARRAY['products',                'manufacturer_id',    'manufacturers',                'manufacturer_visible',    't'],
    ARRAY['products',                'composition_id',     'compositions',                 'composition_visible',     't'],
    ARRAY['products',                'storage_profile_id', 'storage_requirement_profiles', 'storage_profile_visible', 't'],
    ARRAY['products',                'base_unit_id',       'units_of_measure',             'base_unit_visible',       'f'],
    ARRAY['product_packagings',      'unit_id',            'units_of_measure',             'unit_visible',            'f']
  ];
BEGIN
  FOR i IN 1 .. array_length(visible, 1) LOOP
    child       := visible[i][1];
    fk          := visible[i][2];
    parent      := visible[i][3];
    policy_name := visible[i][4];
    nullable    := visible[i][5]::boolean;

    -- A nullable FK permits NULL: a product with no manufacturer recorded is
    -- legitimate, and a policy that refused it would make the column unusable.
    predicate := format(
      '%s EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND (p.organization_id IS NULL OR p.organization_id = app_current_org()))',
      CASE WHEN nullable THEN format('%I.%I IS NULL OR', child, fk) ELSE '' END,
      parent, child, fk
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, child);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE USING (%s) WITH CHECK (%s)',
      policy_name, child, predicate, predicate
    );
  END LOOP;
END
$$;
