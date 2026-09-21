-- DropIndex
DROP INDEX "charge_policy_rules_organization_id_product_id_idx";

-- DropIndex
DROP INDEX "consumption_lines_organization_id_consumption_id_idx";

-- DropIndex
DROP INDEX "dispense_lines_organization_id_dispense_id_idx";

-- DropIndex
DROP INDEX "goods_receipt_lines_organization_id_goods_receipt_id_idx";

-- DropIndex
DROP INDEX "invoice_items_organization_id_invoice_id_idx";

-- DropIndex
DROP INDEX "issuer_tax_registration_branches_organization_id_tax_regist_idx";

-- DropIndex
DROP INDEX "issuer_tax_registrations_organization_id_country_code_idx";

-- DropIndex
DROP INDEX "membership_roles_membership_id_idx";

-- DropIndex
DROP INDEX "online_order_lines_organization_id_online_order_id_idx";

-- DropIndex
DROP INDEX "product_cost_averages_organization_id_branch_id_product_id_idx";

-- DropIndex
DROP INDEX "product_packagings_organization_id_product_id_idx";

-- DropIndex
DROP INDEX "product_prices_organization_id_product_id_idx";

-- DropIndex
DROP INDEX "product_regulatory_profiles_organization_id_product_id_idx";

-- DropIndex
DROP INDEX "product_tax_classifications_organization_id_product_id_coun_idx";

-- DropIndex
DROP INDEX "purchase_order_lines_organization_id_purchase_order_id_idx";

-- DropIndex
DROP INDEX "purchase_requisition_lines_organization_id_requisition_id_idx";

-- DropIndex
DROP INDEX "purchase_return_lines_organization_id_purchase_return_id_idx";

-- DropIndex
DROP INDEX "recall_batches_organization_id_recall_id_idx";

-- DropIndex
DROP INDEX "stock_transfer_lines_organization_id_transfer_id_idx";

-- DropIndex
DROP INDEX "supplier_tax_identifiers_organization_id_supplier_id_idx";

-- DropIndex
DROP INDEX "tax_registrations_country_code_idx";

-- DropIndex
DROP INDEX "unit_conversions_organization_id_from_unit_id_idx";

-- AlterTable
ALTER TABLE "encounter_investigations" ALTER COLUMN "item_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "encounter_procedures" ALTER COLUMN "item_id" DROP NOT NULL;
