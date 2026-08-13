-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'BLACKLISTED');

-- CreateEnum
CREATE TYPE "PurchaseRequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'ORDERED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoodsReceiptQualityStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PurchaseReturnStatus" AS ENUM ('DRAFT', 'SENT', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberSequenceType" ADD VALUE 'PURCHASE_REQUISITION';
ALTER TYPE "NumberSequenceType" ADD VALUE 'PURCHASE_ORDER';
ALTER TYPE "NumberSequenceType" ADD VALUE 'GOODS_RECEIPT';
ALTER TYPE "NumberSequenceType" ADD VALUE 'PURCHASE_RETURN';
ALTER TYPE "NumberSequenceType" ADD VALUE 'DISPENSE';

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'PURCHASE_RETURN';

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "legal_name" VARCHAR(255),
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "contact_person" VARCHAR(255),
    "email" VARCHAR(320),
    "phone" VARCHAR(32),
    "website" VARCHAR(255),
    "address_line1" VARCHAR(255),
    "address_line2" VARCHAR(255),
    "city" VARCHAR(128),
    "region_code" VARCHAR(10),
    "postal_code" VARCHAR(20),
    "country_code" CHAR(2),
    "default_currency" CHAR(3),
    "payment_terms_days" SMALLINT,
    "lead_time_days" SMALLINT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_tax_identifiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "region_code" VARCHAR(10),
    "scheme" "TaxScheme" NOT NULL,
    "registration_number" VARCHAR(64) NOT NULL,
    "legal_name" VARCHAR(255),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "supplier_tax_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_sku" VARCHAR(128) NOT NULL,
    "supplier_product_name" VARCHAR(255),
    "pack_unit_id" UUID NOT NULL,
    "quantity_per_pack" DECIMAL(18,6) NOT NULL,
    "price_per_pack_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "price_effective_from" DATE NOT NULL,
    "price_effective_to" DATE,
    "lead_time_days" SMALLINT,
    "minimum_order_packs" DECIMAL(18,6),
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requisitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "requisition_number" VARCHAR(64),
    "status" "PurchaseRequisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "required_by" DATE,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_id" UUID,
    "rejected_at" TIMESTAMPTZ(6),
    "rejected_by_id" UUID,
    "rejection_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requisition_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "suggested_supplier_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_requisition_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_number" VARCHAR(64),
    "supplier_id" UUID NOT NULL,
    "requisition_id" UUID,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "supplier_name" VARCHAR(255) NOT NULL,
    "supplier_tax_number" VARCHAR(64),
    "currency" CHAR(3) NOT NULL,
    "expected_date" DATE,
    "deliver_to_location_id" UUID,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "terms" TEXT,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_id" UUID,
    "closure_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_product_id" UUID,
    "ordered_quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "received_quantity_base" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "unit_cost_base" BIGINT NOT NULL,
    "price_per_pack_minor" BIGINT,
    "pack_quantity_base" DECIMAL(18,6),
    "line_subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_rate_bps" INTEGER,
    "tax_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "line_total_minor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "receipt_number" VARCHAR(64),
    "supplier_id" UUID NOT NULL,
    "purchase_order_id" UUID,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'DRAFT',
    "supplier_name" VARCHAR(255) NOT NULL,
    "supplier_invoice_number" VARCHAR(64),
    "supplier_invoice_date" DATE,
    "location_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" CHAR(3) NOT NULL,
    "freight_minor" BIGINT NOT NULL DEFAULT 0,
    "duty_minor" BIGINT NOT NULL DEFAULT 0,
    "handling_minor" BIGINT NOT NULL DEFAULT 0,
    "goods_value_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "quality_hold_required" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(6),
    "posted_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "goods_receipt_id" UUID NOT NULL,
    "purchase_order_line_id" UUID,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "received_quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "rejected_quantity_base" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "lot_number" VARCHAR(128),
    "manufactured_on" DATE,
    "expires_on" DATE,
    "retest_on" DATE,
    "manufacturer_id" UUID,
    "serial_number" VARCHAR(128),
    "unit_cost_base" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "landed_cost_minor" BIGINT NOT NULL DEFAULT 0,
    "line_subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_rate_bps" INTEGER,
    "tax_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "line_total_minor" BIGINT NOT NULL DEFAULT 0,
    "quality_status" "GoodsReceiptQualityStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "quality_decided_at" TIMESTAMPTZ(6),
    "quality_decided_by_id" UUID,
    "quality_notes" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_returns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "return_number" VARCHAR(64),
    "supplier_id" UUID NOT NULL,
    "goods_receipt_id" UUID,
    "status" "PurchaseReturnStatus" NOT NULL DEFAULT 'DRAFT',
    "supplier_name" VARCHAR(255) NOT NULL,
    "reason" TEXT NOT NULL,
    "location_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "supplier_credit_note_number" VARCHAR(64),
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(6),
    "sent_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_return_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "purchase_return_id" UUID NOT NULL,
    "goods_receipt_line_id" UUID,
    "product_id" UUID NOT NULL,
    "batch_id" UUID,
    "serial_id" UUID,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "status_from" "StockStatus" NOT NULL,
    "unit_cost_base" BIGINT,
    "currency" CHAR(3),
    "line_total_minor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_cost_averages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "valued_quantity_base" DECIMAL(18,6) NOT NULL,
    "valued_cost_minor" BIGINT NOT NULL,
    "receipt_count" INTEGER NOT NULL DEFAULT 0,
    "last_receipt_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_cost_averages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_organization_id_status_name_idx" ON "suppliers"("organization_id", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_organization_id_code_key" ON "suppliers"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_organization_id_id_key" ON "suppliers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "supplier_tax_identifiers_organization_id_supplier_id_idx" ON "supplier_tax_identifiers"("organization_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_tax_identifiers_organization_id_supplier_id_countr_key" ON "supplier_tax_identifiers"("organization_id", "supplier_id", "country_code", "scheme", "registration_number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_tax_identifiers_organization_id_id_key" ON "supplier_tax_identifiers"("organization_id", "id");

-- CreateIndex
CREATE INDEX "supplier_products_organization_id_product_id_is_active_idx" ON "supplier_products"("organization_id", "product_id", "is_active");

-- CreateIndex
CREATE INDEX "supplier_products_organization_id_supplier_id_is_active_idx" ON "supplier_products"("organization_id", "supplier_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_organization_id_supplier_id_product_id_su_key" ON "supplier_products"("organization_id", "supplier_id", "product_id", "supplier_sku");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_organization_id_id_key" ON "supplier_products"("organization_id", "id");

-- CreateIndex
CREATE INDEX "purchase_requisitions_organization_id_status_created_at_idx" ON "purchase_requisitions"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_requisitions_organization_id_branch_id_status_idx" ON "purchase_requisitions"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_organization_id_requisition_number_key" ON "purchase_requisitions"("organization_id", "requisition_number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_organization_id_id_key" ON "purchase_requisitions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_organization_id_branch_id_id_key" ON "purchase_requisitions"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "purchase_requisition_lines_organization_id_requisition_id_idx" ON "purchase_requisition_lines"("organization_id", "requisition_id");

-- CreateIndex
CREATE INDEX "purchase_requisition_lines_organization_id_product_id_idx" ON "purchase_requisition_lines"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_requisition_id_p_key" ON "purchase_requisition_lines"("organization_id", "requisition_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisition_lines_organization_id_id_key" ON "purchase_requisition_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_branch_id_status_created_at_idx" ON "purchase_orders"("organization_id", "branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_supplier_id_status_idx" ON "purchase_orders"("organization_id", "supplier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_order_number_key" ON "purchase_orders"("organization_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_id_key" ON "purchase_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_branch_id_id_key" ON "purchase_orders"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "purchase_order_lines_organization_id_purchase_order_id_idx" ON "purchase_order_lines"("organization_id", "purchase_order_id");

-- CreateIndex
CREATE INDEX "purchase_order_lines_organization_id_product_id_idx" ON "purchase_order_lines"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_purchase_order_id_prod_key" ON "purchase_order_lines"("organization_id", "purchase_order_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organization_id_id_key" ON "purchase_order_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "goods_receipts_organization_id_branch_id_status_received_at_idx" ON "goods_receipts"("organization_id", "branch_id", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "goods_receipts_organization_id_supplier_id_received_at_idx" ON "goods_receipts"("organization_id", "supplier_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "goods_receipts_organization_id_purchase_order_id_idx" ON "goods_receipts"("organization_id", "purchase_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_receipt_number_key" ON "goods_receipts"("organization_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_id_key" ON "goods_receipts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_organization_id_branch_id_id_key" ON "goods_receipts"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_organization_id_goods_receipt_id_idx" ON "goods_receipt_lines"("organization_id", "goods_receipt_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_organization_id_product_id_idx" ON "goods_receipt_lines"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_organization_id_purchase_order_line_id_idx" ON "goods_receipt_lines"("organization_id", "purchase_order_line_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_organization_id_branch_id_quality_statu_idx" ON "goods_receipt_lines"("organization_id", "branch_id", "quality_status");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_organization_id_goods_receipt_id_produc_key" ON "goods_receipt_lines"("organization_id", "goods_receipt_id", "product_id", "lot_number", "serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_organization_id_id_key" ON "goods_receipt_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "purchase_returns_organization_id_branch_id_status_created_a_idx" ON "purchase_returns"("organization_id", "branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_returns_organization_id_supplier_id_idx" ON "purchase_returns"("organization_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_organization_id_return_number_key" ON "purchase_returns"("organization_id", "return_number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_organization_id_id_key" ON "purchase_returns"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_organization_id_branch_id_id_key" ON "purchase_returns"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "purchase_return_lines_organization_id_purchase_return_id_idx" ON "purchase_return_lines"("organization_id", "purchase_return_id");

-- CreateIndex
CREATE INDEX "purchase_return_lines_organization_id_product_id_idx" ON "purchase_return_lines"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "purchase_return_lines_organization_id_goods_receipt_line_id_idx" ON "purchase_return_lines"("organization_id", "goods_receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_return_lines_organization_id_purchase_return_id_pr_key" ON "purchase_return_lines"("organization_id", "purchase_return_id", "product_id", "batch_id", "serial_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_return_lines_organization_id_id_key" ON "purchase_return_lines"("organization_id", "id");

-- CreateIndex
CREATE INDEX "product_cost_averages_organization_id_branch_id_product_id_idx" ON "product_cost_averages"("organization_id", "branch_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_cost_averages_organization_id_branch_id_product_id__key" ON "product_cost_averages"("organization_id", "branch_id", "product_id", "currency");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_tax_identifiers" ADD CONSTRAINT "supplier_tax_identifiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_tax_identifiers" ADD CONSTRAINT "supplier_tax_identifiers_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_pack_unit_id_fkey" FOREIGN KEY ("pack_unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_requisition_id_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "purchase_requisitions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_organization_id_suggested_suppl_fkey" FOREIGN KEY ("organization_id", "suggested_supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_requisition_id_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "purchase_requisitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_branch_id_deliver_to_locat_fkey" FOREIGN KEY ("organization_id", "branch_id", "deliver_to_location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_issued_by_id_fkey" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_supplier_product_id_fkey" FOREIGN KEY ("organization_id", "supplier_product_id") REFERENCES "supplier_products"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_purchase_order_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "purchase_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_posted_by_id_fkey" FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_goods_receipt_id_fkey" FOREIGN KEY ("organization_id", "goods_receipt_id") REFERENCES "goods_receipts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_purchase_order_line_id_fkey" FOREIGN KEY ("organization_id", "purchase_order_line_id") REFERENCES "purchase_order_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_manufacturer_id_fkey" FOREIGN KEY ("manufacturer_id") REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_branch_id_serial_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_quality_decided_by_id_fkey" FOREIGN KEY ("quality_decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_organization_id_supplier_id_fkey" FOREIGN KEY ("organization_id", "supplier_id") REFERENCES "suppliers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_organization_id_goods_receipt_id_fkey" FOREIGN KEY ("organization_id", "goods_receipt_id") REFERENCES "goods_receipts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_organization_id_purchase_return_id_fkey" FOREIGN KEY ("organization_id", "purchase_return_id") REFERENCES "purchase_returns"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_organization_id_goods_receipt_line_i_fkey" FOREIGN KEY ("organization_id", "goods_receipt_line_id") REFERENCES "goods_receipt_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_organization_id_branch_id_serial_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_cost_averages" ADD CONSTRAINT "product_cost_averages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_cost_averages" ADD CONSTRAINT "product_cost_averages_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_cost_averages" ADD CONSTRAINT "product_cost_averages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- PI-4 — PROCUREMENT. Everything below this line is hand-written: Prisma
-- Migrate does not generate CHECK constraints, NULLS NOT DISTINCT indexes, RLS
-- policies or grants, and every one of them is load-bearing here.
--
-- ⚠️ THE `stock_ledger_direction` CHECK IS **NOT** UPDATED IN THIS MIGRATION,
--   AND IT HAS TO BE. `PURCHASE_RETURN` is added to `StockMovementType` above,
--   and Postgres refuses to USE a new enum value in the same transaction that
--   added it — `unsafe use of new value of enum type`. The constraint therefore
--   moves to `20260817091000_purchase_return_movement_direction`, which is the
--   whole reason that migration exists. Until it runs, a `PURCHASE_RETURN` row
--   fails the existing CHECK, which is fail-closed and correct.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- NULLS NOT DISTINCT: the two line keys with nullable components.
--
-- ⚠️ WITHOUT THIS THE DUPLICATE-LINE INDEXES DO NOTHING FOR THE COMMONEST CASE.
--   Under Postgres's default two NULLs are DISTINCT, so every line of an
--   untracked product — no lot number, no serial — is unique against every other
--   one, and the same product can be keyed onto one document ten times. That is
--   exactly the shape of the bug PI-3's receipt loop turned into minted stock,
--   and the index is the layer meant to catch it before a service does.
--
--   Same fix `stock_balances`' bucket key and `number_sequences`' arbiter needed.
-- ---------------------------------------------------------------------------
DROP INDEX "goods_receipt_lines_organization_id_goods_receipt_id_produc_key";
CREATE UNIQUE INDEX "goods_receipt_lines_organization_id_goods_receipt_id_produc_key"
  ON "goods_receipt_lines" ("organization_id", "goods_receipt_id", "product_id",
                            "lot_number", "serial_number")
  NULLS NOT DISTINCT;

DROP INDEX "purchase_return_lines_organization_id_purchase_return_id_pr_key";
CREATE UNIQUE INDEX "purchase_return_lines_organization_id_purchase_return_id_pr_key"
  ON "purchase_return_lines" ("organization_id", "purchase_return_id",
                              "product_id", "batch_id", "serial_id")
  NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- Suppliers and their price book.
-- ---------------------------------------------------------------------------

-- A registration that lapsed before it started is a typo, and it would silently
-- drop out of every "which number was in force then" lookup.
ALTER TABLE "supplier_tax_identifiers"
  ADD CONSTRAINT "supplier_tax_identifiers_period_ordered" CHECK (
    "effective_to" IS NULL OR "effective_to" >= "effective_from"
  );

-- ⚠️ `quantity_per_pack > 0` IS THE ONE CONSTRAINT ON THIS TABLE THAT PREVENTS A
--   CLINICAL INCIDENT RATHER THAN A REPORTING ONE. It is the divisor that turns
--   "5 boxes" into base units on every purchase order line; a zero divides by
--   zero and a negative orders backwards. See the model comment for why this is
--   a column and not a lookup through `product_packagings`.
ALTER TABLE "supplier_products"
  ADD CONSTRAINT "supplier_products_quantity_per_pack_positive" CHECK (
    "quantity_per_pack" > 0
  );

ALTER TABLE "supplier_products"
  ADD CONSTRAINT "supplier_products_amounts_non_negative" CHECK (
    "price_per_pack_minor" >= 0
    AND ("minimum_order_packs" IS NULL OR "minimum_order_packs" > 0)
  );

ALTER TABLE "supplier_products"
  ADD CONSTRAINT "supplier_products_price_period_ordered" CHECK (
    "price_effective_to" IS NULL OR "price_effective_to" >= "price_effective_from"
  );

-- ---------------------------------------------------------------------------
-- Requisitions.
-- ---------------------------------------------------------------------------

-- ⚠️ THE SEGREGATION-OF-DUTY CONTROL, AND THE ONLY LAYER OF IT THAT CANNOT BE
--   FORGOTTEN. `procurement.requisition.create` and `.approve` are separate
--   permission codes and the service refuses an approval by the row's own
--   creator, but both of those are one edit away from absent — and an approval
--   control that a later phase can quietly remove is not a control. A clinic
--   that genuinely wants one person to do both grants both codes to one
--   membership, visibly; it still cannot self-approve a single document.
--
--   Mirrors the existing `doctor.schedule.request` / `.approve` split.
ALTER TABLE "purchase_requisitions"
  ADD CONSTRAINT "purchase_requisitions_approver_is_not_creator" CHECK (
    "approved_by_id" IS NULL OR "approved_by_id" <> "created_by_id"
  );

-- A refusal with no reason is a refusal the requester cannot act on, so they
-- raise it again unchanged. All three columns move together.
ALTER TABLE "purchase_requisitions"
  ADD CONSTRAINT "purchase_requisitions_rejection_complete" CHECK (
    ("rejected_at" IS NULL     AND "rejected_by_id" IS NULL     AND "rejection_reason" IS NULL)
    OR
    ("rejected_at" IS NOT NULL AND "rejected_by_id" IS NOT NULL AND "rejection_reason" IS NOT NULL)
  );

-- ⚠️ A POST-DRAFT STATUS WITH NO NUMBER AND NO SUBMISSION TIME IS A DOCUMENT
--   NOBODY CAN PUT ON A TIMELINE. The mirror of PI-3's
--   `stock_transfers_dispatched_states_complete`, and it is what makes "the
--   number is issued on submit, never at create" a property of the table rather
--   than of one service.
--
--   `CANCELLED` is deliberately unconstrained: it is reachable from DRAFT (no
--   number was ever issued) and from SUBMITTED or APPROVED (one was).
ALTER TABLE "purchase_requisitions"
  ADD CONSTRAINT "purchase_requisitions_submitted_states_complete" CHECK (
    CASE "status"
      WHEN 'DRAFT' THEN
        "requisition_number" IS NULL AND "submitted_at" IS NULL AND "submitted_by_id" IS NULL
      WHEN 'CANCELLED' THEN true
      ELSE
        "requisition_number" IS NOT NULL
        AND "submitted_at" IS NOT NULL
        AND "submitted_by_id" IS NOT NULL
    END
  );

ALTER TABLE "purchase_requisitions"
  ADD CONSTRAINT "purchase_requisitions_approval_complete" CHECK (
    "status" NOT IN ('APPROVED', 'ORDERED')
    OR ("approved_at" IS NOT NULL AND "approved_by_id" IS NOT NULL)
  );

ALTER TABLE "purchase_requisition_lines"
  ADD CONSTRAINT "purchase_requisition_lines_quantity_positive" CHECK (
    "quantity_base" > 0 AND "quantity_entered" > 0
  );

-- ---------------------------------------------------------------------------
-- Purchase orders.
-- ---------------------------------------------------------------------------

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_issued_states_complete" CHECK (
    CASE "status"
      WHEN 'DRAFT' THEN
        "order_number" IS NULL AND "issued_at" IS NULL AND "issued_by_id" IS NULL
      WHEN 'CANCELLED' THEN true
      ELSE
        "order_number" IS NOT NULL
        AND "issued_at" IS NOT NULL
        AND "issued_by_id" IS NOT NULL
    END
  );

-- `CLOSED` means "the buyer decided nothing more is coming" — see the enum. It
-- is the one status whose whole meaning is the reason behind it, so the reason
-- is not optional.
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_closure_complete" CHECK (
    ("closed_at" IS NULL     AND "closed_by_id" IS NULL     AND "closure_reason" IS NULL)
    OR
    ("closed_at" IS NOT NULL AND "closed_by_id" IS NOT NULL AND "closure_reason" IS NOT NULL)
  );

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_cancellation_complete" CHECK (
    ("cancelled_at" IS NULL     AND "cancelled_by_id" IS NULL     AND "cancellation_reason" IS NULL)
    OR
    ("cancelled_at" IS NOT NULL AND "cancelled_by_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
  );

-- Money is recorded, never computed (PI-ADR-006) — but a NEGATIVE amount on a
-- purchase order is not a supplier's pricing decision, it is a bug. A credit is
-- a purchase RETURN.
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_amounts_non_negative" CHECK (
    "subtotal_minor" >= 0 AND "tax_amount_minor" >= 0 AND "total_minor" >= 0
  );

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_quantities_valid" CHECK (
    "ordered_quantity_base" > 0
    AND "quantity_entered" > 0
    -- ⚠️ NO UPPER BOUND AGAINST `ordered_quantity_base`, AND THAT IS THE ONE
    --   PLACE THIS FILE DIVERGES FROM `stock_transfer_lines` ON PURPOSE. A
    --   transfer can refuse over-receipt absolutely because the SENDER counted;
    --   a supplier legitimately over-ships, and how much slack is acceptable is
    --   the `procurement.over_receipt_tolerance_percent` SETTING (PI-ADR-015),
    --   which a CHECK cannot read. Enforced in goods-receipt.service.ts, which
    --   is why that rule has its own test.
    AND "received_quantity_base" >= 0
  );

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_amounts_non_negative" CHECK (
    "unit_cost_base" >= 0
    AND "line_subtotal_minor" >= 0
    AND "tax_amount_minor" >= 0
    AND "line_total_minor" >= 0
    AND ("price_per_pack_minor" IS NULL OR "price_per_pack_minor" >= 0)
  );

-- The money equivalent of `quantity_entered` + `unit_id`: "₹412 per box of 100"
-- is two numbers or neither. Half of it is a price per nothing.
ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_pack_price_complete" CHECK (
    ("price_per_pack_minor" IS NULL) = ("pack_quantity_base" IS NULL)
    AND ("pack_quantity_base" IS NULL OR "pack_quantity_base" > 0)
  );

-- ---------------------------------------------------------------------------
-- Goods receipts. The most consequential document in the phase.
-- ---------------------------------------------------------------------------

-- ⚠️ `CANCELLED` REQUIRES `posted_at IS NULL`, AND THAT SINGLE CLAUSE IS WHAT
--   MAKES "THERE IS NO REVERSAL" A PROPERTY OF THE DATABASE. A posted receipt
--   has written `PURCHASE_RECEIPT` legs, created lot rows and moved a moving
--   average; cancelling it would leave every one of those standing while the
--   document claimed nothing happened. A receipt posted in error is corrected by
--   a purchase return or an adjustment with a reason — a compensating movement,
--   never an edit (PI-ADR-004 rule 3).
ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_posted_states_complete" CHECK (
    CASE "status"
      WHEN 'DRAFT' THEN
        "receipt_number" IS NULL AND "posted_at" IS NULL AND "posted_by_id" IS NULL
      WHEN 'POSTED' THEN
        "receipt_number" IS NOT NULL
        AND "posted_at" IS NOT NULL
        AND "posted_by_id" IS NOT NULL
      WHEN 'CANCELLED' THEN
        "posted_at" IS NULL
        AND "cancelled_at" IS NOT NULL
        AND "cancelled_by_id" IS NOT NULL
        AND "cancellation_reason" IS NOT NULL
    END
  );

ALTER TABLE "goods_receipts"
  ADD CONSTRAINT "goods_receipts_amounts_non_negative" CHECK (
    "freight_minor" >= 0
    AND "duty_minor" >= 0
    AND "handling_minor" >= 0
    AND "goods_value_minor" >= 0
    AND "tax_amount_minor" >= 0
    AND "total_minor" >= 0
  );

-- ⚠️ `rejected <= received` AND **NOT** `received = accepted + rejected`.
--   Rejected stock is not subtracted from what arrived: it is on the premises,
--   it has to be counted and valued until it goes back or is destroyed, and it
--   is the same reasoning that makes `EXPIRY` a MOVE rather than a removal in
--   the ledger. What changes is which bucket it sits in.
ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_quantities_valid" CHECK (
    "received_quantity_base" > 0
    AND "quantity_entered" > 0
    AND "rejected_quantity_base" >= 0
    AND "rejected_quantity_base" <= "received_quantity_base"
  );

-- ⚠️ ONE LINE PER SERIAL, QUANTITY EXACTLY ONE. A serial IS one physical device
--   and `recordMovementIn` takes exactly one `serialId`, so five implants are
--   five legs and five lines. This is what makes a `goods_receipt_line_serials`
--   child table unnecessary — and what stops a line claiming to have received
--   "40 of serial ABC123", which would put 40 units into a bucket keyed by one
--   device.
ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_serial_quantity" CHECK (
    "serial_number" IS NULL OR "received_quantity_base" = 1
  );

-- A lot row or a device row implies the identity it was created from. The
-- converse is not true and must not be: a DRAFT carries the identity the
-- receiver typed and has no rows yet.
ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_identity_complete" CHECK (
    ("batch_id"  IS NULL OR "lot_number"    IS NOT NULL)
    AND ("serial_id" IS NULL OR "serial_number" IS NOT NULL)
  );

ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_amounts_non_negative" CHECK (
    "unit_cost_base" >= 0
    AND "landed_cost_minor" >= 0
    AND "line_subtotal_minor" >= 0
    AND "tax_amount_minor" >= 0
    AND "line_total_minor" >= 0
  );

-- An inspection outcome names who decided and when. `REJECTED` additionally
-- names why — "we refused it" with no reason is not a record anybody can act on,
-- least of all the supplier being asked for a credit.
ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "goods_receipt_lines_quality_decision_complete" CHECK (
    CASE "quality_status"
      WHEN 'NOT_REQUIRED' THEN "quality_decided_at" IS NULL AND "quality_decided_by_id" IS NULL
      WHEN 'PENDING'      THEN "quality_decided_at" IS NULL AND "quality_decided_by_id" IS NULL
      WHEN 'ACCEPTED'     THEN "quality_decided_at" IS NOT NULL AND "quality_decided_by_id" IS NOT NULL
      WHEN 'REJECTED'     THEN "quality_decided_at" IS NOT NULL
                               AND "quality_decided_by_id" IS NOT NULL
                               AND "quality_notes" IS NOT NULL
    END
  );

-- ---------------------------------------------------------------------------
-- Purchase returns.
-- ---------------------------------------------------------------------------

-- `CANCELLED` requires `sent_at IS NULL`, for the reason the goods receipt's
-- does: a sent return has written `PURCHASE_RETURN` legs and the stock has left.
-- Stock that comes back from a supplier is a new GOODS RECEIPT, which is what it
-- physically is.
ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_sent_states_complete" CHECK (
    CASE "status"
      WHEN 'DRAFT' THEN
        "return_number" IS NULL AND "sent_at" IS NULL AND "sent_by_id" IS NULL
      WHEN 'SENT' THEN
        "return_number" IS NOT NULL AND "sent_at" IS NOT NULL AND "sent_by_id" IS NOT NULL
      WHEN 'CANCELLED' THEN
        "sent_at" IS NULL
        AND "cancelled_at" IS NOT NULL
        AND "cancelled_by_id" IS NOT NULL
        AND "cancellation_reason" IS NOT NULL
    END
  );

ALTER TABLE "purchase_returns"
  ADD CONSTRAINT "purchase_returns_amount_non_negative" CHECK ("total_minor" >= 0);

ALTER TABLE "purchase_return_lines"
  ADD CONSTRAINT "purchase_return_lines_quantity_positive" CHECK (
    "quantity_base" > 0 AND "quantity_entered" > 0
  );

-- A number with no currency is a number that will be added to a different one —
-- the same pairing `batches` already enforces on its cost.
ALTER TABLE "purchase_return_lines"
  ADD CONSTRAINT "purchase_return_lines_cost_currency_paired" CHECK (
    ("unit_cost_base" IS NULL) = ("currency" IS NULL)
    AND ("unit_cost_base" IS NULL OR "unit_cost_base" >= 0)
    AND "line_total_minor" >= 0
  );

-- ⚠️ WHICH BUCKETS STOCK MAY LEAVE ON A RETURN, ENUMERATED, BECAUSE THE ENUM IS
--   WIDER THAN THE ANSWER. `RESERVED` is spoken for by somebody and returning it
--   would empty a reservation nothing released; `DISPOSED` has already gone;
--   `IN_TRANSIT` is not a bucket this programme ever fills (PI-3 decision 1).
--   The three ordinary answers are AVAILABLE — ordered in error — QUARANTINED —
--   rejected at inspection — and DAMAGED.
ALTER TABLE "purchase_return_lines"
  ADD CONSTRAINT "purchase_return_lines_status_from_returnable" CHECK (
    "status_from" IN ('AVAILABLE', 'QUARANTINED', 'DAMAGED', 'BLOCKED', 'EXPIRED', 'RECALLED')
  );

-- ---------------------------------------------------------------------------
-- Costing.
-- ---------------------------------------------------------------------------

ALTER TABLE "product_cost_averages"
  ADD CONSTRAINT "product_cost_averages_non_negative" CHECK (
    "valued_quantity_base" >= 0
    AND "valued_cost_minor" >= 0
    AND "receipt_count" >= 0
  );

-- ⚠️ VALUE WITH NO QUANTITY IS A DIVISION BY ZERO IN THE ONLY QUERY THIS TABLE
--   EXISTS FOR. The average is `valued_cost_minor / valued_quantity_base`,
--   computed at read rather than stored so the rounding does not compound (see
--   the model comment). A row with a value and a zero denominator is
--   unreadable, so it is unwritable.
ALTER TABLE "product_cost_averages"
  ADD CONSTRAINT "product_cost_averages_value_implies_quantity" CHECK (
    "valued_quantity_base" > 0 OR "valued_cost_minor" = 0
  );

-- ===========================================================================
-- Row-level security. MIRRORS prisma/rls/enable-rls.sql — see the banner there.
--
-- ⚠️ TWELVE NEW TENANT TABLES, TWO TENANCY CLASSES, AND THE SEAM IS BRANCH
--   RATHER THAN PLATFORM. Nothing in this phase is platform-extensible: a
--   supplier, a price agreed with them and every purchase document are facts
--   about ONE clinic (PI-ADR-003). What differs is the branch half — the three
--   supplier tables are org-wide because a group negotiates one contract for
--   every site, and all nine document tables are branch-scoped because a
--   requisition is raised at a site and a delivery arrives at one loading bay.
--   The reasoning, and what it costs, is on the `Supplier` model.
-- ===========================================================================

DO $$
DECLARE
  t text;
  procurement text[] := ARRAY[
    -- ORG-SCOPED, no branch at all.
    'suppliers',
    'supplier_tax_identifiers',
    'supplier_products',
    -- BRANCH-SCOPED as well — every one of these also appears in the branch loop
    -- immediately below.
    'purchase_requisitions',
    'purchase_requisition_lines',
    'purchase_orders',
    'purchase_order_lines',
    'goods_receipts',
    'goods_receipt_lines',
    'purchase_returns',
    'purchase_return_lines',
    'product_cost_averages'
  ];
BEGIN
  FOREACH t IN ARRAY procurement LOOP
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

-- ---------------------------------------------------------------------------
-- The branch half.
--
-- ⚠️ EVERY CHILD CARRIES ITS OWN `organization_id` AND `branch_id` AND JOINS BOTH
--   LOOPS, RATHER THAN INHERITING THROUGH A PARENT PREDICATE. That is the call
--   the invoice children made and NOT the one `appointment_status_history` made,
--   and the difference is measured rather than argued: a policy expression is
--   evaluated with row security DISABLED on the tables it references, so an
--   EXISTS against `purchase_orders` would not pick up that table's branch
--   policy, and the branch half would simply not be asked. Every storekeeper in
--   the organization would read every branch's order lines and unit costs. See
--   the `status_history_branch_predicate` migration for the counts.
--
-- `branch_id` is NOT NULL on all nine, so the `IS NULL` half of the predicate is
-- dead code for them and the policy is ABSOLUTE. It is kept character-for-
-- character identical to the loop in enable-rls.sql so the two files cannot
-- drift into meaning different things.
--
-- ⚠️ THE THREE SUPPLIER TABLES ARE DELIBERATELY ABSENT. They have no `branch_id`
--   column, so this predicate would name a column that does not exist and the
--   CREATE POLICY would raise here, at migration time — which is how PI-3 found
--   out that `stock_transfers` could not join the generic loop either.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  branch_scoped text[] := ARRAY[
    'purchase_requisitions',
    'purchase_requisition_lines',
    'purchase_orders',
    'purchase_order_lines',
    'goods_receipts',
    'goods_receipt_lines',
    'purchase_returns',
    'purchase_return_lines',
    'product_cost_averages'
  ];
BEGIN
  FOREACH t IN ARRAY branch_scoped LOOP
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
-- The RESTRICTIVE visibility policies. Same shape and reasoning as PI-1's,
-- PI-2's and PI-3's, and the same stakes.
--
-- Every foreign key below points at a table whose rows MAY be platform rows —
-- a clinic legitimately buys, orders, receives and values a PLATFORM product —
-- so it cannot be a composite `(organization_id, id)` FK: there is no
-- organization_id on the target to compose with. `tenant_isolation` constrains
-- the row's OWN organization and says NOTHING about what it points AT.
--
-- Without these a clinic puts another clinic's private product on its own
-- purchase order, price book or goods receipt and reads the name, composition
-- and manufacturer straight back out through the join. It is a valid insert into
-- a table the caller is allowed to write, and nothing else in the system
-- notices.
--
-- ⚠️ RESTRICTIVE. A PERMISSIVE policy here would OR — WIDENING access rather than
--   narrowing it, the exact opposite of the intent — and would typecheck, deploy
--   and pass every single-tenant test.
--
-- Written as the same loop enable-rls.sql uses rather than twelve copies of one
-- EXISTS, because the copies are where one of them ends up subtly different.
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
    ARRAY['supplier_products',           'product_id',      'products',         'product_visible',      'f'],
    -- The WORD the supplier uses for their pack. Presentation only — the
    -- conversion is `quantity_per_pack` — but a unit is still a possibly-platform
    -- row whose name would be read back out of the join.
    ARRAY['supplier_products',           'pack_unit_id',    'units_of_measure', 'unit_visible',         'f'],
    ARRAY['purchase_requisition_lines',  'product_id',      'products',         'product_visible',      'f'],
    ARRAY['purchase_requisition_lines',  'unit_id',         'units_of_measure', 'unit_visible',         'f'],
    ARRAY['purchase_order_lines',        'product_id',      'products',         'product_visible',      'f'],
    ARRAY['purchase_order_lines',        'unit_id',         'units_of_measure', 'unit_visible',         'f'],
    ARRAY['goods_receipt_lines',         'product_id',      'products',         'product_visible',      'f'],
    ARRAY['goods_receipt_lines',         'unit_id',         'units_of_measure', 'unit_visible',         'f'],
    -- The lot's manufacturer as read off the pack, which may differ from the
    -- product's default. Nullable: an untracked line records none.
    ARRAY['goods_receipt_lines',         'manufacturer_id', 'manufacturers',    'manufacturer_visible', 't'],
    ARRAY['purchase_return_lines',       'product_id',      'products',         'product_visible',      'f'],
    ARRAY['purchase_return_lines',       'unit_id',         'units_of_measure', 'unit_visible',         'f'],
    -- ⚠️ THE COST AVERAGE NEEDS ONE TOO, AND IT IS THE LEAST OBVIOUS OF THE
    --   TWELVE. Nothing a tenant sends creates this row directly — the receipt
    --   service upserts it — but the row NAMES a product, and a clinic that
    --   forged one against another clinic's private product would read that
    --   product's name out of the valuation screen's join.
    ARRAY['product_cost_averages',       'product_id',      'products',         'product_visible',      'f']
  ];
BEGIN
  FOR i IN 1 .. array_length(visible, 1) LOOP
    child       := visible[i][1];
    fk          := visible[i][2];
    parent      := visible[i][3];
    policy_name := visible[i][4];
    nullable    := visible[i][5]::boolean;

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

-- ===========================================================================
-- Grants.
--
-- ⚠️ THE INIT SCRIPT'S BLANKET `GRANT ... ON ALL TABLES` RAN LONG BEFORE THESE
--   TABLES EXISTED, SO THEY HAVE NO GRANTS AT ALL UNTIL THIS RUNS. The same trap
--   PI-2 and PI-3 both hit, and the symptom is a flat `permission denied for
--   table suppliers` on the very first request. `scripts/apply-grants.ts`
--   re-applies these after a reset; both are needed, for the reason recorded in
--   the PI-2 changelog.
--
-- Ordinary read/write on all twelve. ⚠️ NONE IS APPEND-ONLY AND NONE IS A
--   TRIGGER-MAINTAINED CACHE. A draft is edited, a quality decision is recorded
--   on a posted line, and `product_cost_averages` is upserted by the receipt
--   service. `stock_ledger` and `stock_balances` are the tables with the
--   REVOKEs and nothing here changes them: every quantity these documents move
--   still goes through `recordMovementIn` (PI-ADR-004).
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "suppliers"                  TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_tax_identifiers"   TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "supplier_products"          TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_requisitions"      TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_requisition_lines" TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_orders"            TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_order_lines"       TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "goods_receipts"             TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "goods_receipt_lines"        TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_returns"           TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "purchase_return_lines"      TO rcln_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "product_cost_averages"      TO rcln_app;
