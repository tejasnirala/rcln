-- =============================================================================
-- Patient invoicing: invoices, invoice_items, invoice_taxes, invoice_documents.
--
-- Phase 3 of the invoice engine. ⚠️ NOT `subscription_invoices` — that table is
-- rcln billing the clinic and is complete. These four are the clinic billing a
-- patient, under the clinic's own registration, with the BRANCH as the place of
-- supply. See §0.1 of .kb/Architecture/invoice-engine-implementation.md.
--
-- Hand-written after `prisma migrate diff`, which cannot emit any of:
--   * the RLS policies (tenant AND branch on all four tables)
--   * the RESTRICTIVE file_in_same_org policy that replaces the composite FK
--     invoice_documents cannot have, because files.organization_id is nullable
--   * the discount CHECK constraints, which stop a type and its input
--     disagreeing
--   * the CHECK tying an invoice number to an issued status
--   * the CHECK tying the source type to its reference column
--   * the PARTIAL unique index on invoice_documents
--   * the `IF NOT EXISTS` on the new NumberSequenceType value, which Postgres
--     needs because ALTER TYPE ... ADD VALUE has no inverse
--
-- The two `appointment_vitals` renames `migrate diff` also proposes are
-- pre-existing drift from 20260809180000_vitals_revisions and are deliberately
-- left out to keep this migration scoped, exactly as Phases 1 and 2 did.
-- =============================================================================

-- CreateEnum
CREATE TYPE "InvoiceSourceType" AS ENUM ('APPOINTMENT', 'PROCEDURE', 'SERVICE', 'LAB', 'PHARMACY', 'INVENTORY', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'FINALIZING', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceDiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- AlterTable
-- ---------------------------------------------------------------------------
-- Widen `number_sequences.prefix` from 16 to 64, and add the INVOICE counter
-- type it serves.
--
-- ⚠️ THE WIDTH WAS FOUND BY RUNNING THE CODE, NOT BY READING IT. An invoice
--   prefix carries the branch code — `INV-2026-APP-MAIN-` is already 18
--   characters and `branches.code` is VARCHAR(32) on its own. The old width was
--   sized for `P` and `MRN-`, and the overflow surfaced as a raw Postgres 22001
--   from inside `issueNumber`'s $queryRaw, at the exact moment a cashier
--   finalises a bill. No type, lint or schema check could see it.
--
-- Widening a varchar is a catalogue-only change in Postgres: no table rewrite,
-- and every existing value stays valid.
--
-- `IF NOT EXISTS` on the enum value because ALTER TYPE ... ADD VALUE has no
-- inverse in Postgres — there is no DROP VALUE — so this statement has to be
-- safe to meet an enum that already carries it.
-- ---------------------------------------------------------------------------
ALTER TABLE "number_sequences" ALTER COLUMN "prefix" SET DATA TYPE VARCHAR(64);
ALTER TYPE "NumberSequenceType" ADD VALUE IF NOT EXISTS 'INVOICE';

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "invoice_number" VARCHAR(64),
    "source_type" "InvoiceSourceType" NOT NULL,
    "appointment_id" UUID,
    "patient_id" UUID,
    "customer_name" VARCHAR(255) NOT NULL,
    "customer_phone" VARCHAR(20),
    "customer_email" VARCHAR(255),
    "customer_address" TEXT,
    "customer_tax_id" VARCHAR(32),
    "supplied_at" TIMESTAMPTZ(6) NOT NULL,
    "issued_at" TIMESTAMPTZ(6),
    "due_date" DATE,
    "issuer_tax_registration_id" UUID,
    "issuer_tax_id" VARCHAR(64),
    "issuer_legal_name" VARCHAR(255),
    "place_of_supply" VARCHAR(10),
    "tax_treatment" "TaxTreatment" NOT NULL DEFAULT 'NOT_REGISTERED',
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_discount_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount_type" "InvoiceDiscountType",
    "discount_bps" INTEGER,
    "discount_fixed" DECIMAL(14,2),
    "invoice_discount_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxable_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rounding_adjustment" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "cancellation_reason" TEXT,
    "created_by" UUID,
    "issued_by" UUID,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "item_code" VARCHAR(32),
    "tax_category" VARCHAR(64) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "gross_amount" DECIMAL(14,2) NOT NULL,
    "discount_type" "InvoiceDiscountType",
    "discount_bps" INTEGER,
    "discount_fixed" DECIMAL(14,2),
    "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "apportioned_discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxable_amount" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(14,2) NOT NULL,
    "tax_treatment" "TaxTreatment" NOT NULL DEFAULT 'UNRATED',
    "tax_reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_taxes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "invoice_item_id" UUID NOT NULL,
    "tax_rule_id" UUID,
    "tax_rule_default_id" UUID,
    "name" VARCHAR(32) NOT NULL,
    "jurisdiction" VARCHAR(10),
    "rate_bps" INTEGER NOT NULL,
    "taxable_amount" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "treatment" "TaxTreatment" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_taxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" UUID,
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_organization_id_branch_id_status_created_at_idx" ON "invoices"("organization_id", "branch_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "invoices_organization_id_patient_id_created_at_idx" ON "invoices"("organization_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "invoices_organization_id_appointment_id_idx" ON "invoices"("organization_id", "appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_invoice_number_key" ON "invoices"("organization_id", "invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_id_key" ON "invoices"("organization_id", "id");

-- CreateIndex
CREATE INDEX "invoice_items_organization_id_invoice_id_idx" ON "invoice_items"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_organization_id_id_key" ON "invoice_items"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_organization_id_invoice_id_line_number_key" ON "invoice_items"("organization_id", "invoice_id", "line_number");

-- CreateIndex
CREATE INDEX "invoice_taxes_organization_id_invoice_id_idx" ON "invoice_taxes"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "invoice_taxes_organization_id_invoice_item_id_idx" ON "invoice_taxes"("organization_id", "invoice_item_id");

-- CreateIndex
CREATE INDEX "invoice_documents_organization_id_invoice_id_idx" ON "invoice_documents"("organization_id", "invoice_id");

-- CreateIndex
CREATE INDEX "invoice_documents_organization_id_file_id_idx" ON "invoice_documents"("organization_id", "file_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_appointment_id_fkey" FOREIGN KEY ("organization_id", "appointment_id") REFERENCES "appointments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_issuer_tax_registration_id_fkey" FOREIGN KEY ("organization_id", "issuer_tax_registration_id") REFERENCES "issuer_tax_registrations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_organization_id_invoice_item_id_fkey" FOREIGN KEY ("organization_id", "invoice_item_id") REFERENCES "invoice_items"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_organization_id_tax_rule_id_fkey" FOREIGN KEY ("organization_id", "tax_rule_id") REFERENCES "tax_rules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_tax_rule_default_id_fkey" FOREIGN KEY ("tax_rule_default_id") REFERENCES "tax_rule_defaults"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- The document index Prisma cannot express: PARTIAL, on the live row only.
--
-- ⚠️ A PLAIN UNIQUE HERE WOULD BREAK THE ONE CASE `superseded_at` EXISTS FOR.
--   An invoice has at most ONE current PDF and at most one current credit note.
--   It may have several dead ones: a render that FAILED and was retried leaves
--   the failed row behind, because a document row is written before its bytes
--   and the failure has to stay findable. Constraining every row would refuse
--   the retry — the invoice would be issued, its PDF permanently missing, and
--   the error would surface at the front desk.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "invoice_documents_current_per_type_key"
  ON "invoice_documents" ("organization_id", "invoice_id", "document_type")
  WHERE "superseded_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Discount inputs: the type and the value it implies must agree.
--
-- ⚠️ THE COLUMN THAT IS SET IS PART OF THE MEANING, NOT A STORAGE DETAIL.
--   "10% off" and "₹150 off" are different instructions that can produce the
--   same amount, and the invoice prints which one was given. A row carrying
--   discount_type = PERCENTAGE with only discount_fixed populated is not a
--   half-filled form — it is a discount that computes one way and prints
--   another. Nothing in TypeScript prevents it; three columns and an enum are
--   exactly the shape a partial `update()` gets wrong.
--
--   Percentages are basis points so the input stays an integer, bounded at
--   100%: a discount larger than the line is a negative charge, which is a
--   credit note and goes through a different door.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_input_matches_type" CHECK (
  ("discount_type" IS NULL       AND "discount_bps" IS NULL     AND "discount_fixed" IS NULL)
  OR ("discount_type" = 'PERCENTAGE' AND "discount_bps" IS NOT NULL AND "discount_fixed" IS NULL
      AND "discount_bps" BETWEEN 0 AND 10000)
  OR ("discount_type" = 'FIXED'      AND "discount_fixed" IS NOT NULL AND "discount_bps" IS NULL
      AND "discount_fixed" >= 0)
);

ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_discount_input_matches_type" CHECK (
  ("discount_type" IS NULL       AND "discount_bps" IS NULL     AND "discount_fixed" IS NULL)
  OR ("discount_type" = 'PERCENTAGE' AND "discount_bps" IS NOT NULL AND "discount_fixed" IS NULL
      AND "discount_bps" BETWEEN 0 AND 10000)
  OR ("discount_type" = 'FIXED'      AND "discount_fixed" IS NOT NULL AND "discount_bps" IS NULL
      AND "discount_fixed" >= 0)
);

-- Print order is 1-based and positive. A zero or negative line number sorts
-- ahead of every real line on a document a patient reads.
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_line_number_positive"
  CHECK ("line_number" >= 1);

-- ---------------------------------------------------------------------------
-- A tax line resolved from ONE rule, and we record which table it came from.
--
-- ⚠️ THE DISTINCTION IS THE POINT, NOT THE CONSTRAINT.
--   `tax_rules` is what the clinic chose; `tax_rule_defaults` is rcln's
--   published rate for the country, inherited at read time. Which one priced a
--   line is the difference between a rate the clinic authored and one it merely
--   accepted, and that is the question the rate-card screen — and an auditor —
--   actually asks. Both NULL is legitimate: an UNRATED or NOT_REGISTERED line
--   involved no rule at all, and neither does a rate from an external provider.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_one_rule_source" CHECK (
  NOT ("tax_rule_id" IS NOT NULL AND "tax_rule_default_id" IS NOT NULL)
);

ALTER TABLE "invoice_taxes" ADD CONSTRAINT "invoice_taxes_rate_bps_non_negative"
  CHECK ("rate_bps" >= 0);

-- ---------------------------------------------------------------------------
-- The source type and the reference column must agree.
--
-- ⚠️ THE CLAUSE LIST GROWS WITH THE MODULES, AND THAT IS THE DESIGN.
--   There is deliberately no generic `source_id`. A single polymorphic uuid
--   cannot be foreign-keyed anywhere, and the composite (organization_id, id)
--   reference is the ONLY thing that makes a cross-tenant link
--   unrepresentable — so a loose uuid would let an invoice bill another
--   clinic's appointment with nothing raising an error, mitigated only by a
--   service remembering to re-read it. Each integrated source therefore gets
--   its own column and its own FK: `lab_order_id` arrives with the lab module,
--   in the migration that creates `lab_orders` anyway.
--
--   Stub tables holding just an id were considered and rejected: a link to a
--   table with no organization_id proves the row EXISTS and says nothing about
--   who owns it, which is the wrong half of the problem.
--
--   PROCEDURE, SERVICE and OTHER carry no reference at all — a manual invoice
--   cites nothing, and the service catalogue the first two will point at does
--   not exist yet. When it does, this CHECK is where that is recorded.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_reference_matches_type" CHECK (
  ("source_type" = 'APPOINTMENT' AND "appointment_id" IS NOT NULL)
  OR ("source_type" <> 'APPOINTMENT' AND "appointment_id" IS NULL)
);

-- ---------------------------------------------------------------------------
-- A number and an issue date are one fact, and DRAFT may hold neither.
--
-- ⚠️ THE TWO FAILURES THIS REFUSES ARE THE TWO THAT BREAK THE SERIES.
--   An ISSUED invoice with no number is a document that cannot be cited on a
--   return. A DRAFT that already carries one has consumed a serial that will
--   never appear on any document, leaving a gap the clinic has to explain years
--   later. `issueNumber()` is called at finalisation precisely so the second
--   cannot happen; this constraint is what makes that a property of the data
--   rather than of one service remembering to.
--
--   FINALIZING and CANCELLED are deliberately unconstrained. FINALIZING is the
--   uncommitted middle of the transaction that sets all three. CANCELLED is
--   reachable from DRAFT, where there is no number to require.
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number_matches_status" CHECK (
  ("status" = 'DRAFT' AND "invoice_number" IS NULL AND "issued_at" IS NULL)
  OR ("status" IN ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID')
      AND "invoice_number" IS NOT NULL AND "issued_at" IS NOT NULL)
  OR "status" IN ('FINALIZING', 'CANCELLED')
);

-- ---------------------------------------------------------------------------
-- Row-Level Security. Prisma Migrate does not manage policies.
--
-- ⚠️ ALL FOUR TABLES GET **BOTH** POLICIES, AND THE CHILDREN GET THEM IN THEIR
--   OWN RIGHT RATHER THAN THROUGH THE PARENT.
--   The obvious alternative — the `parent_isolation` shape used by
--   `subscription_invoice_lines` — asks the ORGANIZATION question only, and a
--   policy expression evaluates with row security DISABLED on the table it
--   reads. A child of a BRANCH-scoped parent therefore inherits nothing of the
--   branch boundary, which is the hole `appointment_status_history` had to
--   restate by hand. Carrying organization_id and branch_id on every row makes
--   these ordinary members of both loops; the composite FK to
--   invoices(organization_id, id) is what stops the columns disagreeing with
--   the invoice they belong to.
--
-- Kept identical to prisma/rls/enable-rls.sql, which is the file db:rls:check
-- reads. Both must change together or the check passes on a database that has
-- drifted from the source.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  invoice_tables text[] := ARRAY[
    'invoices', 'invoice_items', 'invoice_taxes', 'invoice_documents'
  ];
BEGIN
  FOREACH t IN ARRAY invoice_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- Explicit: the owner must keep bypassing, so migrations and seeds work.
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);

    -- RESTRICTIVE: permissive policies OR together, so the branch predicate has
    -- to AND with the tenant one rather than widen it.
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
-- invoice_documents.file_id is a PLAIN foreign key, and this policy is what
-- replaces the composite one ADR-0004 would otherwise require.
--
-- ⚠️ THE COMPOSITE FK IS NOT AVAILABLE HERE, AND NOT BY OVERSIGHT.
--   `files.organization_id` is NULLABLE — platform assets share the table — so
--   a FK from invoice_documents' NOT NULL organization_id cannot reference
--   (files.organization_id, files.id). Without this policy an invoice could
--   point at another tenant's PDF: tenant_isolation checks the row's OWN
--   organization_id, which would be perfectly correct, and says nothing at all
--   about the file it cites.
--
--   Note this is STRICTER than `files`' own tenant_isolation, which permits a
--   NULL organization_id so platform assets are readable by everyone. An
--   invoice document is never a platform asset, so NULL is refused outright.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS file_in_same_org ON invoice_documents;
CREATE POLICY file_in_same_org ON invoice_documents AS RESTRICTIVE
  USING      (EXISTS (SELECT 1 FROM files f
                      WHERE f.id = invoice_documents.file_id
                        AND f.organization_id = app_current_org()))
  WITH CHECK (EXISTS (SELECT 1 FROM files f
                      WHERE f.id = invoice_documents.file_id
                        AND f.organization_id = app_current_org()));

-- No GRANT here: `ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner` in
-- infra/postgres/init already gives rcln_app DML on every table the owner
-- creates, which is why no other migration grants either.
