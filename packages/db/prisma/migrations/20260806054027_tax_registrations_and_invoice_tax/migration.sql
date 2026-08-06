-- CreateEnum
CREATE TYPE "TaxBehavior" AS ENUM ('EXCLUSIVE', 'INCLUSIVE');

-- CreateEnum
CREATE TYPE "TaxTreatment" AS ENUM ('STANDARD', 'REVERSE_CHARGE', 'ZERO_RATED', 'EXEMPT', 'NOT_REGISTERED');

-- CreateEnum
CREATE TYPE "TaxIdStatus" AS ENUM ('NOT_PROVIDED', 'UNVALIDATED', 'VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "TaxScheme" AS ENUM ('GST', 'VAT', 'SALES_TAX');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "region_code" VARCHAR(10),
ADD COLUMN     "tax_id_status" "TaxIdStatus" NOT NULL DEFAULT 'NOT_PROVIDED';

-- AlterTable
ALTER TABLE "plan_prices" ADD COLUMN     "tax_behavior" "TaxBehavior" NOT NULL DEFAULT 'EXCLUSIVE';

-- AlterTable
ALTER TABLE "subscription_invoice_lines" ADD COLUMN     "tax_jurisdiction" VARCHAR(10),
ADD COLUMN     "tax_name" VARCHAR(32),
ADD COLUMN     "tax_rate_bps" INTEGER;

-- AlterTable
ALTER TABLE "subscription_invoices" ADD COLUMN     "customer_tax_id" VARCHAR(64),
ADD COLUMN     "place_of_supply" VARCHAR(10),
ADD COLUMN     "supplier_tax_id" VARCHAR(64),
ADD COLUMN     "tax_treatment" "TaxTreatment" NOT NULL DEFAULT 'NOT_REGISTERED',
ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "tax_registrations" (
    "id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(10),
    "scheme" "TaxScheme" NOT NULL,
    "registration_number" VARCHAR(64) NOT NULL,
    "standard_rate_bps" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tax_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tax_registrations_country_code_idx" ON "tax_registrations"("country_code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_registrations_country_code_region_code_scheme_key" ON "tax_registrations"("country_code", "region_code", "scheme");
